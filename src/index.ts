#!/usr/bin/env node
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, getAgentVersion } from "./server";
import { error } from "./logger";
import express from "express";
import { program } from "commander";

const startSseServer = async (port: number) => {
	const app = express();
	app.use(express.json());
	const server = createMcpServer();

	let transport: SSEServerTransport | null = null;

	app.post("/mcp", async (req, res) => {
		if (!transport) {
			res.status(400).json({ error: "No SSE connection established. Please connect via GET /mcp first." });
			return;
		}
		// Pass parsed body from express.json() middleware
		await transport.handlePostMessage(req, res, req.body);
	});

	app.get("/mcp", async (req, res) => {
		// Set SSE headers explicitly
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("Connection", "keep-alive");

		if (transport) {
			await transport.close();
		}

		transport = new SSEServerTransport("/mcp", res);
		await server.connect(transport);
	});

	app.listen(port, () => {
		error(`mobile-mcp ${getAgentVersion()} sse server listening on http://localhost:${port}/mcp`);
	});
};

const startStdioServer = async () => {
	try {
		const transport = new StdioServerTransport();

		const server = createMcpServer();
		await server.connect(transport);

		error("mobile-mcp server running on stdio");
	} catch (err: any) {
		console.error("Fatal error in main():", err);
		error("Fatal error in main(): " + JSON.stringify(err.stack));
		process.exit(1);
	}
};

const main = async () => {
	program
		.version(getAgentVersion())
		.option("--port <port>", "Start SSE server on this port")
		.option("--stdio", "Start stdio server (default)")
		.parse(process.argv);

	const options = program.opts();

	if (options.port) {
		await startSseServer(+options.port);
	} else {
		await startStdioServer();
	}
};

main().then();
