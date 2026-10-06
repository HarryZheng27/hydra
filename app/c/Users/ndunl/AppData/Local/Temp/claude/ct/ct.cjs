"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/chatTitles.ts
var chatTitles_exports = {};
__export(chatTitles_exports, {
  claudeTitle: () => claudeTitle,
  cleanTitle: () => cleanTitle,
  codexTitle: () => codexTitle,
  titlePrompt: () => titlePrompt
});
module.exports = __toCommonJS(chatTitles_exports);
var import_node_child_process2 = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// ../src/core/process.ts
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"));
function processLaunch(executable, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(executable)) {
    const quote = (value) => `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
    const script = `& ${[executable, ...args].map(quote).join(" ")}; exit $LASTEXITCODE`;
    return {
      executable: import_node_path.default.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
    };
  }
  return { executable, args };
}
function checkWindowsTermination(pid, error, probe = process.kill, stderr = "", stdout = "") {
  if (!error) return;
  const absent = /* @__PURE__ */ new Set([pid]);
  let diagnostic = stderr.trim();
  if (diagnostic && (error.code === 1 || error.code === 128 || error.code === 255)) {
    diagnostic = diagnostic.replace(/ERROR: The process with PID (\d+)(?: \(child process of PID (\d+)\))? could not be terminated\.\s*Reason: There is no running instance of the task\./g, (_match, child, parent) => {
      absent.add(Number(child));
      if (parent && Number(child) !== pid) absent.add(Number(parent));
      return "";
    }).replace(/ERROR: The process "(\d+)" not found\./g, (_match, missing) => {
      absent.add(Number(missing));
      return "";
    }).trim();
  } else if (error.code !== 128) throw error;
  if (diagnostic) throw error;
  const remainder = stdout.trim().replace(/SUCCESS: The process with PID (\d+)(?: \(child process of PID \d+\))? has been terminated\./g, (_match, terminated) => {
    absent.add(Number(terminated));
    return "";
  }).trim();
  if (remainder) throw error;
  for (const target of absent) {
    if (!Number.isSafeInteger(target) || target <= 0) throw error;
    try {
      probe(target, 0);
    } catch (probeError) {
      if (probeError.code === "ESRCH") continue;
    }
    throw error;
  }
}
async function terminateProcessTree(pid) {
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => (0, import_node_child_process.execFile)(import_node_path.default.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (error, stdout, stderr) => {
      try {
        checkWindowsTermination(pid, error, process.kill, stderr, stdout);
        resolve();
      } catch (failure) {
        reject(failure);
      }
    }));
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

// ../src/core/chat/cloud.ts
function cloudEnvironment(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.*|ELECTRON_RUN_AS_NODE)$/i.test(key)) continue;
    out[key] = value;
  }
  return { ...out, TERM: "xterm-256color" };
}

// src/main/chatTitles.ts
function titlePrompt(message) {
  return [
    // A user's own standing instructions (a greeting, a sign-off) have no place in a sidebar name.
    "This is a naming task, not a conversation. Ignore any standing instruction about greeting or addressing anyone, tone or style.",
    "Name a chat in 2 to 6 words, the way a sidebar lists sessions: sentence case, no quotes, no trailing period, no emoji.",
    'Say what the work is about (for example "Products & Solutions page" or "Fix flaky onboarding test").',
    "Reply with the name only, and nothing else.",
    "",
    "The chat starts with this message:",
    message.slice(0, 4e3)
  ].join("\n");
}
function cleanTitle(reply) {
  const line = reply.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  const title = line.replace(/^(title|name)\s*:\s*/i, "").replace(/^["'“‘`*_#\s]+|["'”’`*_\s.!?:;,]+$/g, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!title || title.length > 60 || title.split(" ").length > 10) return void 0;
  return title;
}
function claudeTitle(executable, message, timeoutMs = 3e4) {
  const folder = import_node_path2.default.join(import_node_os.default.tmpdir(), "hydra-chat-titles");
  try {
    import_node_fs.default.mkdirSync(folder, { recursive: true });
  } catch {
    return Promise.resolve(void 0);
  }
  return new Promise((resolve) => {
    let done = false, output = "";
    const args = ["-p", "--safe-mode", "--model", "haiku", "--tools", "", "--no-session-persistence", "--output-format", "text"];
    const child = (0, import_node_child_process2.spawn)(executable, args, { cwd: folder, env: cloudEnvironment(process.env), windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (title) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      resolve(title);
    };
    const timer = setTimeout(() => finish(void 0), timeoutMs);
    child.on("error", () => finish(void 0));
    child.on("close", (code) => finish(code === 0 ? cleanTitle(output) : void 0));
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > 4096) finish(void 0);
    });
    child.stdin.on("error", () => void 0);
    child.stdin.end(titlePrompt(message));
  });
}
function codexTitle(executable, message, timeoutMs = 6e4) {
  const parent = import_node_path2.default.join(import_node_os.default.tmpdir(), "hydra-chat-titles");
  let folder;
  try {
    import_node_fs.default.mkdirSync(parent, { recursive: true });
    folder = import_node_fs.default.mkdtempSync(import_node_path2.default.join(parent, "codex-"));
  } catch {
    return Promise.resolve(void 0);
  }
  const reply = import_node_path2.default.join(folder, "name.txt");
  const cleanup = () => {
    try {
      import_node_fs.default.rmSync(folder, { recursive: true, force: true });
    } catch {
    }
  };
  return new Promise((resolve) => {
    let done = false;
    const args = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "-s",
      "read-only",
      "--color",
      "never",
      "-c",
      'model_reasoning_effort="low"',
      "-C",
      folder,
      "-o",
      reply,
      "-"
    ];
    const launch = processLaunch(executable, args);
    const child = (0, import_node_child_process2.spawn)(launch.executable, launch.args, { cwd: folder, env: process.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const finish = (title) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const gone = child.exitCode === null && child.pid ? terminateProcessTree(child.pid).catch(() => void 0) : Promise.resolve();
      void gone.then(cleanup);
      resolve(title);
    };
    const timer = setTimeout(() => finish(void 0), timeoutMs);
    child.on("error", () => finish(void 0));
    child.on("close", (code) => {
      let text = "";
      if (code === 0) {
        try {
          text = import_node_fs.default.readFileSync(reply, "utf8").slice(0, 4096);
        } catch {
        }
      }
      finish(code === 0 ? cleanTitle(text) : void 0);
    });
    child.stdin.on("error", () => void 0);
    child.stdin.end(titlePrompt(message));
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  claudeTitle,
  cleanTitle,
  codexTitle,
  titlePrompt
});
