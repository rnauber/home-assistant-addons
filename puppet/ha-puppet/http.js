import http from "node:http";
import { Browser } from "./screenshot.js";
import { isAddOn, hassUrl, hassToken } from "./const.js";
import { RequestHandler } from "./request-handler.js";
import { installShutdownHandlers } from "./shutdown.js";

const browser = new Browser(hassUrl, hassToken);
const requestHandler = new RequestHandler(browser);
const port = 10000;
const server = http.createServer((request, response) =>
  requestHandler.handleRequest(request, response),
);
server.listen(port);
installShutdownHandlers(server, browser);
const now = new Date();
const serverUrl = isAddOn
  ? `http://homeassistant.local:${port}`
  : `http://localhost:${port}`;
console.log(`[${now.toLocaleTimeString()}] Visit server at ${serverUrl}`);
