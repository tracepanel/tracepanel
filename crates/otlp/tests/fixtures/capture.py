# /// script
# requires-python = ">=3.11"
# dependencies = ["opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http"]
# ///
"""Real OTLP/HTTP exports from OpenTelemetry's Python SDK, saved as the agent's test fixtures."""
import sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from opentelemetry import trace, propagate
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.trace import SpanKind, Status, StatusCode

OUT = Path(sys.argv[1])
bodies = []

class Capture(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        bodies.append((self.headers.get("Content-Encoding"), body))
        self.send_response(200)
        self.send_header("Content-Type", "application/x-protobuf")
        self.end_headers()
    def log_message(self, *args):
        pass

server = HTTPServer(("127.0.0.1", 0), Capture)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = f"http://127.0.0.1:{server.server_port}/v1/traces"

def provider(service):
    p = TracerProvider(resource=Resource.create({"service.name": service, "telemetry.sdk.language": "python"}))
    p.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    return p

shop, billing, worker = provider("shop"), provider("billing"), provider("mailer")
t_shop, t_billing, t_worker = shop.get_tracer("opentelemetry.instrumentation.django"), billing.get_tracer("opentelemetry.instrumentation.flask"), worker.get_tracer("opentelemetry.instrumentation.pika")
db = shop.get_tracer("opentelemetry.instrumentation.psycopg")

# shop: GET /orders/{id}, an N+1 on order_item, a Redis GET, and a call to billing that billing serves.
with t_shop.start_as_current_span("GET /orders/{id}", kind=SpanKind.SERVER, attributes={
        "http.request.method": "GET", "url.path": "/orders/7", "http.route": "/orders/{id}",
        "http.response.status_code": 200, "enduser.id": "42"}):
    for item in range(4):
        with db.start_as_current_span("SELECT shop", kind=SpanKind.CLIENT, attributes={
                "db.system.name": "postgresql", "db.namespace": "shop",
                # As psycopg's instrumentation records a query: the statement, its parameters apart.
                "db.query.text": "SELECT * FROM order_item WHERE id = %s",
                "db.query.parameter.0": str(item),
                "server.address": "db", "server.port": 5432,
                "code.file.path": "shop/views.py", "code.line.number": 31, "code.function.name": "order"}):
            time.sleep(0.002)
    with shop.get_tracer("opentelemetry.instrumentation.redis").start_as_current_span("GET", kind=SpanKind.CLIENT, attributes={
            "db.system.name": "redis", "db.operation.name": "GET", "db.query.text": "GET order:7",
            "server.address": "cache", "server.port": 6379}):
        pass
    with shop.get_tracer("opentelemetry.instrumentation.requests").start_as_current_span("POST", kind=SpanKind.CLIENT, attributes={
            "http.request.method": "POST", "url.full": "http://billing:8000/charge",
            "server.address": "billing", "server.port": 8000, "http.response.status_code": 200}):
        headers = {}
        propagate.inject(headers)
        context = propagate.extract(headers)
        with t_billing.start_as_current_span("POST /charge", context=context, kind=SpanKind.SERVER, attributes={
                "http.request.method": "POST", "url.path": "/charge", "http.route": "/charge",
                "http.response.status_code": 500}) as charge:
            with billing.get_tracer("opentelemetry.instrumentation.sqlite3").start_as_current_span("INSERT", kind=SpanKind.CLIENT, attributes={
                    "db.system.name": "sqlite", "db.query.text": "INSERT INTO charge (order_id) VALUES (?)"}):
                pass
            try:
                raise ValueError("card declined")
            except ValueError as error:
                charge.record_exception(error)
                charge.set_status(Status(StatusCode.ERROR, "card declined"))

# mailer: a worker takes a message from RabbitMQ.
with t_worker.start_as_current_span("orders process", kind=SpanKind.CONSUMER, attributes={
        "messaging.system": "rabbitmq", "messaging.operation.type": "process",
        "messaging.destination.name": "orders"}):
    with worker.get_tracer("opentelemetry.instrumentation.smtplib").start_as_current_span("send"):
        pass

for p in (shop, billing, worker):
    p.force_flush()
    p.shutdown()
OUT.mkdir(parents=True, exist_ok=True)
for at, (encoding, body) in enumerate(bodies):
    (OUT / f"python-{at}.pb").write_bytes(body)
    print(at, encoding, len(body))
