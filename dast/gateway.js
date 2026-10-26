// A tiny stand-in for the ALB ingress, for the DAST job in CI: one origin, the same path
// routing as deploy/helm/caresignal/templates/ingress.yaml, and /internal/* answered with 404
// (as the load balancer does), so ZAP scans exactly the surface the internet sees.
//
//   node dast/gateway.js        listens on GATEWAY_PORT (8080) and forwards to
//                               INGEST_URL, ASSISTANT_URL, RECORDS_URL
// Node.js built-ins only; no dependencies to install or review.
const http = require("node:http");

const port = Number(process.env.GATEWAY_PORT || 8080);
const upstreams = {
  ingest: new URL(process.env.INGEST_URL || "http://127.0.0.1:8081"),
  assistant: new URL(process.env.ASSISTANT_URL || "http://127.0.0.1:8082"),
  records: new URL(process.env.RECORDS_URL || "http://127.0.0.1:8083"),
};

function route(pathname) {
  if (pathname === "/internal" || pathname.startsWith("/internal/")) return null;
  if (pathname === "/v1/readings") return upstreams.ingest; // pathType: Exact
  if (pathname === "/api/assistant" || pathname.startsWith("/api/assistant/")) return upstreams.assistant;
  return upstreams.records;
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, "http://gateway").pathname;
  } catch {
    res.writeHead(400, { "content-type": "text/plain" }).end("Bad request");
    return;
  }
  const target = route(pathname);
  if (!target) {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  // Like the ALB: drop hop-by-hop headers and set X-Forwarded-*; the client cannot fake them
  const headers = { ...req.headers, host: target.host, "x-forwarded-for": req.socket.remoteAddress, "x-forwarded-proto": "http" };
  delete headers.connection;
  delete headers["keep-alive"];
  const upstream = http.request(
    { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers },
    (up) => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad gateway");
  });
  req.pipe(upstream);
});

server.listen(port, () => console.log(JSON.stringify({ message: "gateway listening", port, upstreams })));
