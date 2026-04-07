import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { ServerResponse } from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");

let libraryXml: string | null = null;

function loadLibrary(): string {
  if (!libraryXml) {
    libraryXml = fs.readFileSync(path.join(dataDir, "oci-library.xml"), "utf8");
  }
  return libraryXml;
}

export function serveLibrary(res: ServerResponse): void {
  const xml = loadLibrary();
  res.writeHead(200, {
    "Content-Type": "application/xml",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "public, max-age=86400",
  });
  res.end(xml);
}
