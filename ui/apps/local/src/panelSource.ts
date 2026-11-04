import { type DataSource, httpSource, withSnapshots } from "@tracepanel/ui";
import { sharingLoads } from "./sharedLoads";

export const base = location.href.split("#")[0] ?? location.href;

const api = new URL("api/", base);

export const source: DataSource = sharingLoads(withSnapshots(httpSource(api), api));
