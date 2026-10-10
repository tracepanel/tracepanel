//! The MCP server: what the project's traces say, for an AI coding agent (Claude Code, Cursor, Codex…), over stdio
//! (`tracepanel-agent mcp`). It reads the store directly and only reads.
//!
//! The protocol is rmcp's, the official SDK: both its eras (stateless requests naming their version in `_meta`, and
//! the earlier `initialize` handshake), discovery, caching hints. What is tracepanel's: the tools (`tools`) and how
//! their answers read (`compact`).

mod compact;
mod tools;

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tracepanel_store_local::Reader;

const INSTRUCTIONS: &str = "Tracepanel records what the app does on each request, task and command: SQL, errors, \
    logs, timings; and finds issues in it (N+1 and duplicate queries, slow queries, long transactions, exceptions) \
    with where in the code and how to fix them. To check a change: find_traces or wait_for_trace for the request, \
    get_trace for what it did, fix, make the request again, compare_traces. Answers leave out SQL parameters and \
    variables' values unless the server was started with --values.";

pub struct Server {
    reader: Reader,
    store: PathBuf,
    dir: PathBuf,
    /// Whether answers show values (SQL parameters, local variables).
    values: bool,
    /// How often `wait_for_trace` looks.
    poll: Duration,
}

impl Server {
    /// The server for the store in `dir` (`.tracepanel`).
    pub fn new(dir: PathBuf, values: bool) -> Self {
        let store = tracepanel_store_local::path_in(&dir);
        Self {
            reader: Reader::new(&store),
            store,
            dir,
            values,
            poll: Duration::from_millis(200),
        }
    }

    /// The console of the agent serving this store, if one does: answers end with a link a person can open.
    fn console_url(&self) -> Option<String> {
        let url = std::fs::read_to_string(self.dir.join("console.addr")).ok()?;
        let url = url.trim();
        (!url.is_empty()).then(|| url.to_owned())
    }

    /// Answers on `input` and `output` (stdin and stdout) until the client goes away.
    pub async fn serve(
        self,
        input: impl AsyncRead + Send + Unpin + 'static,
        output: impl AsyncWrite + Send + Unpin + 'static,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let running = Handler(Arc::new(self)).serve((input, output)).await?;
        running.waiting().await?;
        Ok(())
    }
}

impl Clone for Server {
    fn clone(&self) -> Self {
        Self::new(self.dir.clone(), self.values)
    }
}

/// The server, shared with the threads its reads run on.
struct Handler(Arc<Server>);

impl ServerHandler for Handler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("tracepanel", env!("CARGO_PKG_VERSION"))
                    .with_title("Tracepanel"),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools: Vec<Tool> = serde_json::from_value(tools::list())
            .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        Ok(ListToolsResult::with_all_items(tools))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let server = self.0.clone();
        let name = request.name.to_string();
        let args = Value::Object(request.arguments.unwrap_or_default());
        // SQLite reads (and wait_for_trace's waiting) block: off the async runtime.
        let answer =
            tokio::task::spawn_blocking(move || tools::call(&server, &name, &args).ok_or(name))
                .await
                .map_err(|error| ErrorData::internal_error(error.to_string(), None))?;
        match answer {
            Ok(Ok(text)) => Ok(CallToolResult::success(vec![ContentBlock::text(text)]).into()),
            Ok(Err(tools::Refusal(text))) => {
                Ok(CallToolResult::error(vec![ContentBlock::text(text)]).into())
            }
            Err(name) => Err(ErrorData::invalid_params(
                format!("unknown tool: {name}"),
                None,
            )),
        }
    }
}
