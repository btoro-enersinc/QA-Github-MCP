import { Octokit } from "@octokit/rest";

/** Largo máximo del diff devuelto al agente, en caracteres. */
const MAX_DIFF_CHARS = 150_000;

/** Repositorio en el que las tools de escritura pueden actuar. */
export interface WritableRepo {
  owner: string;
  repo: string;
}

/** Credenciales y repositorio de escritura leídos del entorno. */
export interface GithubConfig {
  token: string;
  writable: WritableRepo;
}

/**
 * Lee una variable de entorno obligatoria.
 * @param env Entorno del proceso.
 * @param name Nombre de la variable.
 * @returns Valor sin espacios alrededor.
 */
function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }
  return value;
}

/**
 * Carga el token y el único repositorio donde se permite escribir.
 * @param env Entorno del proceso. Por defecto, `process.env`.
 * @returns Configuración lista para crear el cliente.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  return {
    token: requireEnv(env, "GITHUB_PERSONAL_ACCESS_TOKEN"),
    writable: {
      owner: requireEnv(env, "PLAYWRIGHT_GITHUB_OWNER"),
      repo: requireEnv(env, "PLAYWRIGHT_GITHUB_REPO"),
    },
  };
}

/**
 * Crea el cliente de la API de GitHub autenticado con el PAT.
 * @param token Personal access token. No se registra en logs.
 * @returns Cliente Octokit.
 */
export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "mcp-github-ts",
  });
}

/**
 * Impide escribir fuera del repositorio de pruebas Playwright.
 * La comparación es exacta, después de recortar espacios.
 * @param target Repositorio que la tool intenta modificar.
 * @param allowed Único repositorio autorizado.
 */
export function assertWritableRepo(target: WritableRepo, allowed: WritableRepo): void {
  if (target.owner !== allowed.owner || target.repo !== allowed.repo) {
    throw new Error(
      `Escritura prohibida en ${target.owner}/${target.repo}. Solo se permite ${allowed.owner}/${allowed.repo}.`,
    );
  }
}

/**
 * Lee el código HTTP de un error de Octokit, si lo trae.
 * @param error Valor capturado en un catch.
 * @returns Estado HTTP o undefined si el error no viene de la API.
 */
function githubStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

/**
 * Convierte un fallo de la API en un Error con el estado HTTP.
 * Los errores propios del servidor se devuelven sin envolver.
 * @param error Valor capturado en un catch.
 * @returns Error listo para mostrarse al agente.
 */
export function toGitHubError(error: unknown): Error {
  if (error instanceof Error && githubStatus(error) === undefined) {
    return error;
  }
  const status = githubStatus(error);
  const message = error instanceof Error ? error.message : "Error desconocido al llamar a GitHub.";
  if (status === undefined) {
    return new Error(message);
  }
  return new Error(`GitHub respondió ${status}: ${message}`);
}

/**
 * Recorta un diff que no cabe en la ventana de contexto del agente.
 * @param diff Texto unificado del Pull Request.
 * @returns Diff original o una versión cortada con un aviso al final.
 */
function limitDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) {
    return diff;
  }
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncado a ${MAX_DIFF_CHARS} caracteres.]`;
}

/**
 * Obtiene el diff unificado de un Pull Request.
 * Si GitHub rechaza el diff completo, concatena el patch de cada archivo de texto.
 * @param octokit Cliente autenticado.
 * @param owner Dueño del repositorio.
 * @param repo Nombre del repositorio.
 * @param prNumber Número del Pull Request.
 * @returns Diff en texto plano.
 */
export async function getPullRequestDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  try {
    const response = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    if (typeof response.data === "string") {
      return limitDiff(response.data);
    }
  } catch (error) {
    if (githubStatus(error) !== 406) {
      throw toGitHubError(error);
    }
  }

  let files;
  try {
    files = await octokit.paginate(octokit.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
  } catch (error) {
    throw toGitHubError(error);
  }

  const parts: string[] = [];
  for (const file of files) {
    if (!file.patch) {
      continue;
    }
    parts.push(`diff --git a/${file.filename} b/${file.filename}\n${file.patch}`);
  }
  if (parts.length === 0) {
    throw new Error(`El Pull Request ${owner}/${repo}#${prNumber} no tiene diff de texto.`);
  }
  return limitDiff(parts.join("\n"));
}

/**
 * Lee un archivo de texto y decodifica el Base64 de la API de contenidos.
 * @param octokit Cliente autenticado.
 * @param owner Dueño del repositorio.
 * @param repo Nombre del repositorio.
 * @param path Ruta del archivo dentro del repositorio.
 * @param branch Rama o ref de la que se lee el archivo.
 * @returns Contenido UTF-8 del archivo.
 */
export async function getFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string> {
  let data;
  try {
    const response = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    data = response.data;
  } catch (error) {
    throw toGitHubError(error);
  }

  if (Array.isArray(data)) {
    throw new Error(`La ruta ${path} es un directorio. Indica un archivo.`);
  }
  if (data.type !== "file") {
    throw new Error(`La ruta ${path} no es un archivo (${data.type}).`);
  }
  if (data.encoding !== "base64" || typeof data.content !== "string") {
    throw new Error(
      `El archivo ${path} supera el límite de la API de contenidos de GitHub (1 MB) o no tiene contenido UTF-8.`,
    );
  }
  return Buffer.from(data.content, "base64").toString("utf8");
}

/**
 * Crea una rama nueva a partir del SHA de la rama base.
 * No actualiza una rama que ya exista.
 * @param octokit Cliente autenticado.
 * @param allowed Repositorio Playwright autorizado.
 * @param owner Dueño indicado por el agente.
 * @param repo Repositorio indicado por el agente.
 * @param baseBranch Rama de origen, por ejemplo `main`.
 * @param newBranch Nombre de la rama nueva, por ejemplo `sync/pr-1-2`.
 * @returns Ref creada, con el prefijo `refs/heads/`.
 */
export async function createBranch(
  octokit: Octokit,
  allowed: WritableRepo,
  owner: string,
  repo: string,
  baseBranch: string,
  newBranch: string,
): Promise<string> {
  assertWritableRepo({ owner, repo }, allowed);

  let sha: string;
  try {
    const base = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`,
    });
    sha = base.data.object.sha;
  } catch (error) {
    throw toGitHubError(error);
  }

  try {
    const created = await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${newBranch}`,
      sha,
    });
    return created.data.ref;
  } catch (error) {
    if (githubStatus(error) === 422) {
      throw new Error(`La rama ${newBranch} ya existe en ${owner}/${repo}. No se reescribe.`);
    }
    throw toGitHubError(error);
  }
}

/**
 * Crea o actualiza un archivo con un commit directo en la rama indicada.
 * @param octokit Cliente autenticado.
 * @param allowed Repositorio Playwright autorizado.
 * @param owner Dueño indicado por el agente.
 * @param repo Repositorio indicado por el agente.
 * @param branch Rama que recibe el commit.
 * @param path Ruta del archivo.
 * @param content Contenido completo del archivo, en UTF-8.
 * @param message Mensaje del commit.
 * @returns SHA del commit creado.
 */
export async function commitFileChanges(
  octokit: Octokit,
  allowed: WritableRepo,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  assertWritableRepo({ owner, repo }, allowed);

  let sha: string | undefined;
  try {
    const existing = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });
    if (Array.isArray(existing.data) || existing.data.type !== "file" || !existing.data.sha) {
      throw new Error(`La ruta ${path} no es un archivo y no se puede actualizar.`);
    }
    sha = existing.data.sha;
  } catch (error) {
    if (error instanceof Error && githubStatus(error) === undefined) {
      throw error;
    }
    if (githubStatus(error) !== 404) {
      throw toGitHubError(error);
    }
  }

  try {
    const result = await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch,
      sha,
    });
    const commitSha = result.data.commit.sha;
    if (!commitSha) {
      throw new Error("GitHub no devolvió el SHA del commit.");
    }
    return commitSha;
  } catch (error) {
    throw toGitHubError(error);
  }
}

/**
 * Abre un Pull Request y devuelve su URL.
 * @param octokit Cliente autenticado.
 * @param allowed Repositorio Playwright autorizado.
 * @param owner Dueño indicado por el agente.
 * @param repo Repositorio indicado por el agente.
 * @param title Título del Pull Request.
 * @param body Cuerpo del Pull Request, con el dossier de triage.
 * @param headBranch Rama que contiene los cambios.
 * @param baseBranch Rama destino. Por defecto, `main`.
 * @returns URL HTML del Pull Request.
 */
export async function createPullRequest(
  octokit: Octokit,
  allowed: WritableRepo,
  owner: string,
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
): Promise<string> {
  assertWritableRepo({ owner, repo }, allowed);

  try {
    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      title,
      body,
      head: headBranch,
      base: baseBranch,
    });
    const url = response.data.html_url;
    if (!url) {
      throw new Error("GitHub no devolvió la URL del Pull Request.");
    }
    return url;
  } catch (error) {
    throw toGitHubError(error);
  }
}
