import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { Octokit } from "@octokit/rest";
import cors from "cors";
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import { z } from "zod";
import {
  commitFileChanges,
  createBranch,
  createOctokit,
  createPullRequest,
  getFileContent,
  getPullRequestDiff,
  loadConfig,
  type WritableRepo,
} from "./githubClient.js";

const SERVER_NAME = "mcp-github-ts";
const SERVER_VERSION = "1.0.0";

/** Resultado de texto que el agente puede leer. */
interface TextResult {
  content: [{ type: "text"; text: string }];
  isError?: true;
}

/** Argumentos de `get_pull_request_diff`. */
interface PullRequestDiffArgs {
  owner: string;
  repo: string;
  prNumber: number;
}

/** Argumentos de `get_file_content`. */
interface FileContentArgs {
  owner: string;
  repo: string;
  path: string;
  branch: string;
}

/** Argumentos de `create_branch`. */
interface CreateBranchArgs {
  owner: string;
  repo: string;
  baseBranch: string;
  newBranch: string;
}

/** Argumentos de `commit_file_changes`. */
interface CommitFileArgs {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
}

/** Argumentos de `create_pull_request`. */
interface CreatePullRequestArgs {
  owner: string;
  repo: string;
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

/** Unión de argumentos. El cast de `server.tool` evita la inferencia infinita del SDK 1.25. */
type ToolArgs =
  | PullRequestDiffArgs
  | FileContentArgs
  | CreateBranchArgs
  | CommitFileArgs
  | CreatePullRequestArgs;

/**
 * Envuelve un texto como resultado MCP.
 * @param text Contenido devuelto por la tool.
 * @returns Resultado de texto.
 */
function textResult(text: string): TextResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Convierte un fallo en un resultado de tool sin cerrar la sesión SSE.
 * @param error Error de la guarda o de la API de GitHub.
 * @returns Resultado marcado como error.
 */
function errorResult(error: unknown): TextResult {
  const text = error instanceof Error ? error.message : "Error desconocido.";
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Lee el puerto HTTP. Cloud Run inyecta `PORT`; en local el valor es 8080.
 * @param env Entorno del proceso.
 * @returns Puerto entre 1 y 65535.
 */
function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();
  if (!raw) {
    return 8080;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT no es un puerto válido: ${raw}`);
  }
  return port;
}

/**
 * Crea un servidor MCP para una sola sesión SSE.
 * El SDK asocia un transport por servidor, así que cada `GET /sse` tiene el suyo.
 * @param octokit Cliente autenticado contra GitHub.
 * @param writable Único repositorio donde se permite escribir.
 * @returns Servidor con las cinco tools del control de versiones.
 */
function createMcpServer(octokit: Octokit, writable: WritableRepo): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // ZodDefault hace que la inferencia del SDK 1.25 supere el límite de TypeScript.
  // El schema sigue siendo Zod en runtime; el cast solo corta esa inferencia.
  const register = server.tool.bind(server) as unknown as (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    cb: (args: ToolArgs) => Promise<TextResult>,
  ) => void;

  register(
    "get_pull_request_diff",
    "Lee el diff unificado de un Pull Request. Úsalo para los PRs de Frontend y Backend. Es de solo lectura y no modifica ningún repositorio.",
    {
      owner: z.string().min(1),
      repo: z.string().min(1),
      prNumber: z.number().int().positive(),
    },
    async (args) => {
      const input = args as PullRequestDiffArgs;
      try {
        const diff = await getPullRequestDiff(octokit, input.owner, input.repo, input.prNumber);
        return textResult(diff);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "get_file_content",
    "Lee un archivo de texto en una rama. Úsalo para Page Objects y specs. La ruta debe ser un archivo, no un directorio. Es de solo lectura.",
    {
      owner: z.string().min(1),
      repo: z.string().min(1),
      path: z.string().min(1),
      branch: z.string().min(1),
    },
    async (args) => {
      const input = args as FileContentArgs;
      try {
        const content = await getFileContent(octokit, input.owner, input.repo, input.path, input.branch);
        return textResult(content);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "create_branch",
    "Crea una rama en el repositorio Playwright a partir de baseBranch. Solo se permite el owner y el repo configurados. No reescribe una rama existente. Ejemplo de nombre: sync/pr-<frontend>-<backend>.",
    {
      owner: z.string().min(1),
      repo: z.string().min(1),
      baseBranch: z.string().min(1),
      newBranch: z.string().min(1),
    },
    async (args) => {
      const input = args as CreateBranchArgs;
      try {
        const ref = await createBranch(
          octokit,
          writable,
          input.owner,
          input.repo,
          input.baseBranch,
          input.newBranch,
        );
        return textResult(`Rama creada: ${ref}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "commit_file_changes",
    "Crea o actualiza un solo archivo y hace un commit en la rama indicada del repositorio Playwright. El content es el archivo completo, no un parche. Una llamada por archivo.",
    {
      owner: z.string().min(1),
      repo: z.string().min(1),
      branch: z.string().min(1),
      path: z.string().min(1),
      content: z.string(),
      message: z.string().min(1),
    },
    async (args) => {
      const input = args as CommitFileArgs;
      try {
        const sha = await commitFileChanges(
          octokit,
          writable,
          input.owner,
          input.repo,
          input.branch,
          input.path,
          input.content,
          input.message,
        );
        return textResult(`Commit ${sha} en ${input.branch}:${input.path}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  register(
    "create_pull_request",
    "Abre un Pull Request hacia baseBranch en el repositorio Playwright y devuelve su URL. El body debe llevar el dossier de triage. Solo se permite el owner y el repo configurados.",
    {
      owner: z.string().min(1),
      repo: z.string().min(1),
      title: z.string().min(1),
      body: z.string(),
      headBranch: z.string().min(1),
      baseBranch: z.string().min(1).default("main"),
    },
    async (args) => {
      const input = args as CreatePullRequestArgs;
      try {
        const url = await createPullRequest(
          octokit,
          writable,
          input.owner,
          input.repo,
          input.title,
          input.body,
          input.headBranch,
          input.baseBranch,
        );
        return textResult(url);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

/**
 * Arranca Express con el transporte SSE y el health check de Cloud Run.
 * Los timeouts de Node quedan en cero: el tope de la petición lo pone Cloud Run.
 */
function main(): void {
  let config;
  let port: number;
  try {
    config = loadConfig();
    port = readPort(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Configuración inválida.";
    console.error(message);
    process.exit(1);
  }

  const octokit = createOctokit(config.token);
  const sessions = new Map<string, SSEServerTransport>();
  const app = express();
  let shuttingDown = false;

  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST"],
    }),
  );
  app.use(express.json({ limit: "8mb" }));

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).send("OK");
  });

  app.get("/sse", async (_req: Request, res: Response) => {
    if (shuttingDown) {
      res.status(503).send("El servidor se está cerrando.");
      return;
    }
    try {
      const transport = new SSEServerTransport("/messages", res);
      const sessionId = transport.sessionId;
      sessions.set(sessionId, transport);
      transport.onclose = () => {
        sessions.delete(sessionId);
      };
      const server = createMcpServer(octokit, config.writable);
      await server.connect(transport);
    } catch (error) {
      console.error("No se pudo abrir la sesión SSE.", error);
      if (!res.headersSent) {
        res.status(500).send("No se pudo abrir la sesión SSE.");
      }
    }
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    if (!sessionId) {
      res.status(400).send("Falta sessionId.");
      return;
    }
    const transport = sessions.get(sessionId);
    if (!transport) {
      res.status(404).send("Sesión SSE no encontrada.");
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error("Error al procesar el mensaje MCP.", error);
      if (!res.headersSent) {
        res.status(500).send("Error al procesar el mensaje MCP.");
      }
    }
  });

  const httpServer: Server = app.listen(port, "0.0.0.0", () => {
    console.error(`${SERVER_NAME} escuchando en 0.0.0.0:${port}`);
  });
  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 0;
  httpServer.timeout = 0;

  /**
   * Cierra las sesiones SSE y el HTTP server cuando Cloud Run envía SIGTERM.
   * @param signal Señal recibida.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`Cerrando por ${signal}.`);
    for (const [sessionId, transport] of sessions) {
      try {
        await transport.close();
      } catch (error) {
        console.error(`No se pudo cerrar la sesión ${sessionId}.`, error);
      }
      sessions.delete(sessionId);
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    process.exit(0);
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main();
