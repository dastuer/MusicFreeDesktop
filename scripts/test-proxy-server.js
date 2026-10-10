/**
 * 极简 HTTP 代理测试服务器：
 *  - 记录每条 CONNECT（HTTPS 隧道）与绝对形式 HTTP 请求到 stdout 与 /tmp/proxy-test.log
 *  - CONNECT 直接转发给目标（不起 MITM），用于验证应用是否真的把流量送到了代理
 * 启动：node scripts/test-proxy-server.js [port]
 */
const http = require("http");
const net = require("net");
const fs = require("fs");

const PORT = Number(process.argv[2] || 18888);
const LOG = "/tmp/proxy-test.log";

function record(line) {
    const msg = `[${new Date().toISOString()}] ${line}`;
    console.log(msg);
    fs.appendFileSync(LOG, msg + "\n");
}

const server = http.createServer((req, res) => {
    // 绝对 URI 形式的普通 HTTP 代理请求
    record(`HTTP ${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("via-proxy-http");
});

server.on("connect", (req, clientSocket, head) => {
    record(`CONNECT ${req.url}`);
    const [host, port] = req.url.split(":");
    const upstream = net.connect(Number(port) || 443, host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
    });
    upstream.on("error", (e) => {
        record(`CONNECT ${req.url} upstream error: ${e.message}`);
        clientSocket.destroy();
    });
    clientSocket.on("error", () => upstream.destroy());
});

server.listen(PORT, "127.0.0.1", () => {
    record(`test proxy listening on 127.0.0.1:${PORT}`);
});
