#!/usr/bin/env node
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, getAgentVersion } from "./server";
import { error } from "./logger";
import express from "express";
import { program } from "commander";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const startHttpServer = async (port: number, transportType: "sse" | "streamable" | "both" = "both") => {
	const app = express();
	app.use(express.json());

	// CORS設定（Cloud Run用）
	// 環境変数ALLOWED_ORIGINSが設定されている場合はそれを使用、なければ*を許可
	const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map(o => o.trim()) || ["*"];
	app.use((req, res, next) => {
		const origin = req.headers.origin;
		if (allowedOrigins.includes("*") || (origin && allowedOrigins.includes(origin))) {
			res.setHeader("Access-Control-Allow-Origin", origin || "*");
		}
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
		if (req.method === "OPTIONS") {
			return res.sendStatus(204);
		}
		next();
	});

	// ヘルスチェック用エンドポイント（Cloud Run用）
	app.get("/health", (req, res) => {
		res.json({ status: "ok" });
	});

	const server = createMcpServer();

	// SSEトランスポート用（後方互換性のため）
	let sseTransport: SSEServerTransport | null = null;

	// Streamable HTTPトランスポート用（セッション管理）
	const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

	// Streamable HTTPトランスポートのハンドラー
	if (transportType === "streamable" || transportType === "both") {
		app.post("/mcp", async (req, res) => {
			try {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;
				let transport: StreamableHTTPServerTransport;

				if (sessionId && streamableTransports[sessionId]) {
					// 既存セッションの再利用
					transport = streamableTransports[sessionId];
				} else if (!sessionId && isInitializeRequest(req.body)) {
					// 新しいセッションの初期化
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => randomUUID(),
						onsessioninitialized: (id: string) => {
							streamableTransports[id] = transport;
						}
					});

					transport.onclose = () => {
						if (transport.sessionId) {
							delete streamableTransports[transport.sessionId];
						}
					};

					await server.connect(transport);
				} else {
					res.status(400).json({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Invalid session" },
						id: null
					});
					return;
				}

				await transport.handleRequest(req, res, req.body);
			} catch (err: any) {
				error(`Error handling POST /mcp: ${err.message}`);
				if (!res.headersSent) {
					res.status(500).json({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal error" },
						id: null
					});
				}
			}
		});

		app.get("/mcp", async (req, res) => {
			try {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;
				const transport = sessionId ? streamableTransports[sessionId] : undefined;
				if (transport) {
					await transport.handleRequest(req, res);
				} else {
					res.status(400).json({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Invalid session" },
						id: null
					});
				}
			} catch (err: any) {
				error(`Error handling GET /mcp: ${err.message}`);
				if (!res.headersSent) {
					res.status(500).json({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal error" },
						id: null
					});
				}
			}
		});

		app.delete("/mcp", async (req, res) => {
			try {
				const sessionId = req.headers["mcp-session-id"] as string | undefined;
				const transport = sessionId ? streamableTransports[sessionId] : undefined;
				if (transport) {
					await transport.handleRequest(req, res);
				} else {
					res.status(400).json({
						jsonrpc: "2.0",
						error: { code: -32000, message: "Invalid session" },
						id: null
					});
				}
			} catch (err: any) {
				error(`Error handling DELETE /mcp: ${err.message}`);
				if (!res.headersSent) {
					res.status(500).json({
						jsonrpc: "2.0",
						error: { code: -32603, message: "Internal error" },
						id: null
					});
				}
			}
		});
	}

	// SSEトランスポートのハンドラー（後方互換性のため）
	if (transportType === "sse" || transportType === "both") {
		app.post("/sse", async (req, res) => {
			try {
				if (!sseTransport) {
					res.status(400).json({ error: "No SSE connection established. Please connect via GET /sse first." });
					return;
				}
				await sseTransport.handlePostMessage(req, res, req.body);
			} catch (err: any) {
				error(`Error handling POST /sse: ${err.message}`);
				if (!res.headersSent) {
					res.status(500).json({ error: "Internal server error" });
				}
			}
		});

		app.get("/sse", async (req, res) => {
			try {
				res.setHeader("Content-Type", "text/event-stream");
				res.setHeader("Cache-Control", "no-cache, no-transform");
				res.setHeader("Connection", "keep-alive");

				if (sseTransport) {
					await sseTransport.close();
				}

				sseTransport = new SSEServerTransport("/sse", res);
				await server.connect(sseTransport);
			} catch (err: any) {
				error(`Error handling GET /sse: ${err.message}`);
				if (!res.headersSent) {
					res.status(500).json({ error: "Internal server error" });
				}
			}
		});
	}

	const portEnv = process.env.PORT || port;
	app.listen(portEnv, () => {
		const transportInfo = transportType === "both"
			? "Streamable HTTP & SSE"
			: transportType === "streamable"
				? "Streamable HTTP"
				: "SSE";
		error(`mobile-mcp ${getAgentVersion()} ${transportInfo} server listening on http://0.0.0.0:${portEnv}/mcp`);
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
		.option("--port <port>", "Start HTTP server on this port")
		.option("--stdio", "Start stdio server (default)")
		.option("--transport <type>", "Transport type: sse, streamable, or both (default: both)", "both")
		.parse(process.argv);

	const options = program.opts();

	if (options.port) {
		const transportType = options.transport === "sse" ? "sse"
			: options.transport === "streamable" ? "streamable"
				: "both";
		await startHttpServer(+options.port, transportType);
	} else {
		await startStdioServer();
	}
};

main().then();
