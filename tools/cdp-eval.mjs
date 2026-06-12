// Minimal CDP client: evaluates a JS expression in the OpenStudio editor page.
// Usage: node cdp-eval.mjs <port> <expression>
// The app must be launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>.

const [port, expression] = [process.argv[2] ?? "9222", process.argv[3] ?? "1+1"];

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find(
  (t) => t.type === "page" && (t.url.includes("app.openstudio") || t.url.includes("localhost")),
);
if (!page) {
  console.error("NO_PAGE: " + targets.map((t) => `${t.type}:${t.url}`).join(" | "));
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("CDP timeout")), 30000);
  ws.onopen = () => {
    ws.send(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 1) {
      clearTimeout(timer);
      resolve(msg.result);
    }
  };
  ws.onerror = (e) => reject(new Error("WS error"));
});
ws.close();

if (result.exceptionDetails) {
  console.log("JS_EXCEPTION: " + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
} else {
  console.log(JSON.stringify(result.result.value));
}
