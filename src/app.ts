/// <reference types="vite/client" />
import "./styles.css";

// Config do tabuleiro
const MAX_ROWS = 20;
const ALL_COLS = "ABCDEFGH".split("") as Array<string>;

function calcHealth(config: GameConfig): number {
  // Permite sobreviver a ~60% das minas totais, com mínimo de 10
  const totalMines = config.rows * config.minesPerRow;
  return Math.max(10, Math.ceil(totalMines * config.mineDamage * 0.6));
}

type GameConfig = { rows: number; minesPerRow: number; mineDamage: number };

const DEFAULT_CONFIG: GameConfig = { rows: 8, minesPerRow: 3, mineDamage: 1 };

function colsForConfig(_config: GameConfig): string[] {
  return [...ALL_COLS]; // Sempre 8 colunas A-H, independente do número de linhas
}

// ---------------------------
// Tema (dark/light)
// ---------------------------
type Theme = "dark" | "light";
const THEME_KEY = "x-minas-theme";

function getPreferredTheme(): Theme {
  const saved = (localStorage.getItem(THEME_KEY) || "").toLowerCase();
  if (saved === "dark" || saved === "light") return saved;
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.remove("theme-dark", "theme-light");
  document.documentElement.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
  localStorage.setItem(THEME_KEY, theme);

  const btn = document.getElementById("btnTheme") as HTMLButtonElement | null;
  if (btn) btn.textContent = theme === "dark" ? "🌙" : "☀️";
}

function toggleTheme() {
  const isDark = document.documentElement.classList.contains("theme-dark");
  applyTheme(isDark ? "light" : "dark");
}

// ---------------------------
// PWA: service worker + install
// ---------------------------
if ("serviceWorker" in navigator) {
  const swUrl = `${import.meta.env.BASE_URL}sw.js`;
  navigator.serviceWorker.register(swUrl).catch(() => { });
}

// Tipagem mínima (nem todo TS lib inclui isso)
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;
window.addEventListener("beforeinstallprompt", (e: Event) => {
  e.preventDefault();
  deferredInstallPrompt = e as BeforeInstallPromptEvent;
  const btn = document.getElementById("btnInstall") as HTMLButtonElement | null;
  if (!btn) return;
  btn.hidden = false;
  btn.onclick = async () => {
    try {
      btn.hidden = true;
      await deferredInstallPrompt?.prompt();
      deferredInstallPrompt = null;
    } catch { }
  };
});

// Inicializa tema e botão
applyTheme(getPreferredTheme());
const themeBtn = document.getElementById("btnTheme") as HTMLButtonElement | null;
if (themeBtn) themeBtn.addEventListener("click", toggleTheme);

// ---------------------------
// App state
// ---------------------------
const appEl = document.getElementById("app") as HTMLElement;

type Screen =
  | "menu"
  | "offline_setup"
  | "offline_play"
  | "offline_end"
  | "online_lobby"
  | "online_setup"
  | "online_play"
  | "online_end";

type ServerState = {
  roomCode: string;
  phase: "waiting" | "setup" | "play" | "finished";
  config: GameConfig;
  turnPlayerId: string | null;
  winnerId: string | null;
  you: {
    id: string;
    name: string;
    slot: number;
    points: number;
    currentRow: number;
    attemptedByRow: string[][];
    mineHitsByRow: string[][];
    setupSubmitted: boolean;
  } | null;
  opponent: {
    id: string;
    name: string;
    slot: number;
    points: number;
    currentRow: number;
    attemptedByRow: string[][];
    mineHitsByRow: string[][];
    setupSubmitted: boolean;
  } | null;
  playersCount: number;
};

type TrapRow = { row: number; x: string | null; mines: string[] };

const appState: {
  screen: Screen;
  log: string;
  offline: OfflineGame | null;
  ws: WebSocket | null;
  wsStatus: "connecting" | "connected" | "disconnected";
  wsQueue: unknown[];
  serverState: ServerState | null;
  playerId: string | null;
  name: string;
  name2: string;
  roomCodeInput: string;
  pendingConfig: GameConfig;
  lastExplosion: { row: number; col: string; slot: number; at: number } | null;
} = {
  screen: "menu",
  log: "Bem-vindo! Escolha um modo para começar.",
  offline: null,
  ws: null,
  wsStatus: "disconnected",
  wsQueue: [],
  serverState: null,
  playerId: null,
  name: "",
  name2: "",
  roomCodeInput: "",
  pendingConfig: { ...DEFAULT_CONFIG },
  lastExplosion: null
};

function setLog(text: string) {
  appState.log = String(text || "");
  render();
}

function triggerExplosion(slot: number, row: number, col: string) {
  appState.lastExplosion = { slot, row, col, at: Date.now() };
  render();
  // limpa após a animação
  window.setTimeout(() => {
    // só limpa se ainda for o mesmo evento
    if (appState.lastExplosion && appState.lastExplosion.slot === slot && appState.lastExplosion.row === row && appState.lastExplosion.col === col) {
      appState.lastExplosion = null;
      render();
    }
  }, 900);
}

// ---------------------------
// Helpers
// ---------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const boolProps = new Set(["disabled", "hidden", "checked", "selected", "readonly", "multiple"]);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") (node as HTMLElement).className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      const eventName = k.slice(2).toLowerCase();
      node.addEventListener(eventName, v as EventListener);
    } else if (k === "style" && typeof v === "string") {
      (node as HTMLElement).style.cssText = v;
    } else if (k === "value" && (node as any).value !== undefined) {
      // inputs/selects/textarea: usar propriedade, não atributo
      (node as any).value = v ?? "";
    } else if (boolProps.has(k.toLowerCase())) {
      // atributos booleanos: presença desabilita mesmo com "false"
      (node as any)[k.toLowerCase()] = Boolean(v);
      if (!v) node.removeAttribute(k);
      else node.setAttribute(k, "");
    } else if (v !== undefined && v !== null) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of Array.isArray(children) ? children : [children]) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function card(title: string, bodyChildren: Node[]) {
  return el("section", { class: "card" }, [el("h2", { text: title }), ...bodyChildren]);
}

function pill(text: string) {
  return el("span", { class: "pill", text });
}

function cloneTraps(traps: TrapRow[]): TrapRow[] {
  return traps.map((r) => ({ row: r.row, x: r.x, mines: [...r.mines] }));
}

function newEmptyTraps(rows: number): TrapRow[] {
  return Array.from({ length: rows }, (_, i) => ({ row: i + 1, x: null as string | null, mines: [] as string[] }));
}

function randInt(max: number) {
  return Math.floor(Math.random() * max);
}

function pickDistinct<T>(items: T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const idx = randInt(pool.length);
    out.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return out;
}

function randomTrapsAllRows(config: GameConfig): TrapRow[] {
  const cols = colsForConfig(config);
  return Array.from({ length: config.rows }, (_, i) => {
    const row = i + 1;
    const picks = pickDistinct(cols, config.minesPerRow + 1);
    const x = picks[0] ?? "A";
    const mines = picks.slice(1, config.minesPerRow + 1);
    return { row, x, mines };
  });
}

function randomizeDraftInPlace(draft: TrapRow[], config: GameConfig) {
  const rnd = randomTrapsAllRows(config);
  for (let i = 0; i < config.rows; i++) {
    draft[i].x = rnd[i].x;
    draft[i].mines = [...rnd[i].mines];
  }
}

function randomizeDraftRowInPlace(draft: TrapRow[], row: number, config: GameConfig) {
  const cols = colsForConfig(config);
  const picks = pickDistinct(cols, config.minesPerRow + 1);
  const x = picks[0] ?? "A";
  const mines = picks.slice(1, config.minesPerRow + 1);
  const r = draft[row - 1];
  if (!r) return;
  r.x = x;
  r.mines = [...mines];
}

function validateTraps(traps: TrapRow[], config: GameConfig): string | null {
  if (!Array.isArray(traps) || traps.length !== config.rows) return `É necessário configurar as ${config.rows} linhas.`;
  for (const r of traps) {
    if (!r.x) return `Faltou definir o X na linha ${r.row}.`;
    if (!Array.isArray(r.mines) || r.mines.length !== config.minesPerRow)
      return `Faltou definir ${config.minesPerRow} minas na linha ${r.row}.`;
    const s = new Set(r.mines);
    if (s.size !== config.minesPerRow) return `Minas repetidas na linha ${r.row}.`;
    if (s.has(r.x)) return `O X não pode coincidir com mina na linha ${r.row}.`;
  }
  return null;
}

// ---------------------------
// Offline game engine
// ---------------------------
type OfflinePlayer = {
  name: string;
  points: number;
  currentRow: number;
  attemptedByRow: Array<Set<string>>;
  mineHitsByRow: Array<Set<string>>;
};

type OfflineGame = {
  config: GameConfig;
  phase: "setup" | "play" | "finished";
  players: [OfflinePlayer, OfflinePlayer];
  trapsByTargetIndex: Record<number, TrapRow[] | null>;
  currentTurnIndex: 0 | 1;
  winnerIndex: 0 | 1 | null;
  setupStep: 0 | 1;
  setupDraft: TrapRow[];
  setupRow: number;
};

function createOfflineGame(config: GameConfig): OfflineGame {
  return {
    config,
    phase: "setup",
    players: [
      {
        name: "Jogador 1",
        points: calcHealth(config),
        currentRow: 1,
        attemptedByRow: Array.from({ length: config.rows }, () => new Set()),
        mineHitsByRow: Array.from({ length: config.rows }, () => new Set())
      },
      {
        name: "Jogador 2",
        points: calcHealth(config),
        currentRow: 1,
        attemptedByRow: Array.from({ length: config.rows }, () => new Set()),
        mineHitsByRow: Array.from({ length: config.rows }, () => new Set())
      }
    ],
    trapsByTargetIndex: { 0: null, 1: null },
    currentTurnIndex: 0,
    winnerIndex: null,
    setupStep: 0,
    setupDraft: newEmptyTraps(config.rows),
    setupRow: 1
  };
}

function offlineOpponentIndex(i: 0 | 1): 0 | 1 {
  return i === 0 ? 1 : 0;
}

function offlineSubmitSetup() {
  const g = appState.offline;
  if (!g) return;
  const err = validateTraps(g.setupDraft, g.config);
  if (err) return setLog(err);

  const target: 0 | 1 = g.setupStep === 0 ? 1 : 0;
  g.trapsByTargetIndex[target] = cloneTraps(g.setupDraft);

  if (g.setupStep === 0) {
    g.setupStep = 1;
    g.setupDraft = newEmptyTraps(g.config.rows);
    g.setupRow = 1;
    setLog("Setup salvo. Agora o Jogador 2 configura as armadilhas do Jogador 1.");
    return render();
  }

  g.phase = "play";
  g.currentTurnIndex = Math.random() < 0.5 ? 0 : 1;
  setLog(`Setup concluído! Começa o ${g.players[g.currentTurnIndex].name}.`);
  appState.screen = "offline_play";
  render();
}

function offlineMove(col: string) {
  const g = appState.offline;
  if (!g || g.phase !== "play") return;

  const pi = g.currentTurnIndex;
  const p = g.players[pi];
  const row = p.currentRow;
  if (row < 1 || row > g.config.rows) return;

  const attempted = p.attemptedByRow[row - 1];
  if (attempted.has(col)) return setLog("Você já tentou essa coluna nesta linha.");
  attempted.add(col);

  const traps = g.trapsByTargetIndex[pi];
  if (!traps) return setLog("Erro: armadilhas não configuradas.");
  const rowTrap = traps.find((t) => t.row === row)!;
  const mines = new Set(rowTrap.mines);

  if (col === rowTrap.x) {
    p.currentRow++;
    if (p.currentRow === g.config.rows + 1) {
      g.phase = "finished";
      g.winnerIndex = pi;
      appState.screen = "offline_end";
      setLog(`${p.name} encontrou o último X e venceu!`);
      return;
    }
    setLog(`${p.name} encontrou o X na linha ${row} e avançou para a linha ${p.currentRow}.`);
  } else if (mines.has(col)) {
    p.points = Math.max(0, p.points - g.config.mineDamage);
    p.mineHitsByRow[row - 1].add(col);
    triggerExplosion(pi, row, col);
    if (p.points <= 0) {
      g.phase = "finished";
      g.winnerIndex = offlineOpponentIndex(pi);
      appState.screen = "offline_end";
      setLog(`${p.name} caiu em uma mina e ficou sem pontos. ${g.players[g.winnerIndex].name} venceu!`);
      return;
    }
    setLog(`${p.name} caiu em uma mina (-${g.config.mineDamage}). Pontos agora: ${p.points}.`);
  } else {
    setLog(`${p.name} não encontrou nada nessa célula.`);
  }

  g.currentTurnIndex = offlineOpponentIndex(pi);
  render();
}

// ---------------------------
// Online (WebSocket)
// ---------------------------
function wsUrlFromLocation() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

function connectOnline() {
  if (appState.ws && appState.ws.readyState === WebSocket.CONNECTING) return;
  if (appState.ws && appState.ws.readyState === WebSocket.OPEN) {
    // Já conectado, apenas reenvia o nome
    const name = (appState.name || "").trim() || "Jogador";
    appState.ws.send(JSON.stringify({ type: "set_name", name }));
    setLog("Nome atualizado no servidor.");
    return;
  }
  appState.wsStatus = "connecting";
  render();

  const ws = new WebSocket(wsUrlFromLocation());
  appState.ws = ws;

  ws.onopen = () => {
    appState.wsStatus = "connected";
    const name = (appState.name || "").trim() || "Jogador";
    ws.send(JSON.stringify({ type: "set_name", name }));
    // flush de ações pendentes (ex.: criar/entrar sala clicado antes de conectar)
    const queued = [...appState.wsQueue];
    appState.wsQueue = [];
    for (const q of queued) ws.send(JSON.stringify(q));
    setLog("Conectado. Crie ou entre em uma sala.");
  };

  ws.onerror = () => {
    // O navegador não expõe detalhes do erro por segurança.
    setLog("Falha ao conectar no WebSocket. Verifique se você está acessando a URL correta do servidor (não use localhost no 2º dispositivo).");
  };

  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }

    if (msg.type === "connected") {
      if (msg.defaultConfig) appState.pendingConfig = { ...msg.defaultConfig };
      return;
    }

    if (msg.type === "room_joined") {
      appState.playerId = msg.playerId;
      appState.serverState = msg.state as ServerState;
      if (appState.serverState?.roomCode) appState.roomCodeInput = appState.serverState.roomCode;
      syncScreenWithServer();
      render();
      return;
    }

    if (msg.type === "room_state") {
      appState.serverState = msg.state as ServerState;
      if (appState.serverState?.roomCode) appState.roomCodeInput = appState.serverState.roomCode;
      syncScreenWithServer();
      render();
      return;
    }

    if (msg.type === "move_result") {
      const you = appState.serverState?.you;
      const opp = appState.serverState?.opponent;
      const who = msg.playerId === you?.id ? "Você" : "Oponente";
      if (msg.outcome === "x") setLog(`${who} encontrou X na linha ${msg.row} (coluna ${msg.col})!`);
      else if (msg.outcome === "mine") {
        setLog(`${who} caiu em mina na linha ${msg.row} (coluna ${msg.col}) (-${msg.pointsLost}).`);
        const slot = msg.playerId === you?.id ? you?.slot : opp?.slot;
        if (typeof slot === "number") triggerExplosion(slot, msg.row, String(msg.col).toUpperCase());
      }
      else setLog(`${who} não encontrou nada na linha ${msg.row} (coluna ${msg.col}).`);
      return;
    }

    if (msg.type === "error") {
      setLog(msg.message || "Erro.");
      return;
    }
  };

  ws.onclose = () => {
    appState.wsStatus = "disconnected";
    appState.serverState = null;
    appState.playerId = null;
    appState.wsQueue = [];
    setLog("Desconectado do servidor.");
    render();
  };
}

function wsSend(obj: unknown, opts: { queueIfDisconnected?: boolean } = { queueIfDisconnected: true }) {
  if (appState.ws && appState.ws.readyState === WebSocket.OPEN) {
    appState.ws.send(JSON.stringify(obj));
    return;
  }

  if (opts.queueIfDisconnected) {
    appState.wsQueue.push(obj);
    connectOnline();
    setLog("Conectando...");
    return;
  }

  setLog("Sem conexão.");
}

function syncScreenWithServer() {
  const s = appState.serverState;
  if (!s) return;
  if (s.phase === "waiting" || s.phase === "setup") appState.screen = "online_lobby";
  if (s.phase === "setup") {
    if (appState.screen !== "online_setup") resetOnlineSetup(s.config ?? appState.pendingConfig);
    appState.screen = "online_setup";
  }
  if (s.phase === "play") appState.screen = "online_play";
  if (s.phase === "finished") appState.screen = "online_end";
}

// online setup draft (client-only)
const onlineSetup: { trapsDraft: TrapRow[]; row: number } = {
  trapsDraft: newEmptyTraps(DEFAULT_CONFIG.rows),
  row: 1
};

function resetOnlineSetup(config: GameConfig) {
  onlineSetup.trapsDraft = newEmptyTraps(config.rows);
  onlineSetup.row = 1;
}

function onlineSubmitSetup() {
  const config = appState.serverState?.config ?? appState.pendingConfig;
  const err = validateTraps(onlineSetup.trapsDraft, config);
  if (err) return setLog(err);
  wsSend({ type: "setup_submit", trapsForOpponent: cloneTraps(onlineSetup.trapsDraft) });
  setLog("Setup enviado. Aguardando oponente...");
}

function onlineMove(col: string) {
  wsSend({ type: "move", col });
}

// ---------------------------
// UI parts
// ---------------------------
function progressList(currentRow: number, config: GameConfig) {
  const items: Node[] = [];
  for (let r = 1; r <= config.rows; r++) {
    const status = currentRow > r ? "ok" : currentRow === r ? "warn" : "";
    const label = currentRow > r ? "X encontrado" : currentRow === r ? "Linha atual" : "Pendente";
    items.push(el("div", { class: `tag ${status}`.trim(), text: `${r}: ${label}` }));
  }
  return el("div", { class: "row" }, items);
}

function setupRowEditor(
  trapsDraft: TrapRow[],
  row: number,
  onToggleMine: (col: string) => void,
  onSetX: (col: string) => void,
  config: GameConfig
) {
  const cols = colsForConfig(config);
  const r = trapsDraft[row - 1];
  const minesLeft = config.minesPerRow - r.mines.length;
  const xSet = !!r.x;

  const header = el("div", { class: "flex flex-wrap gap-2 justify-center" }, [
    pill(`Editando L${row}`),
    pill(`Minas restantes: ${Math.max(0, minesLeft)}`),
    pill(`X: ${xSet ? r.x! : "pendente"}`)
  ]);

  const grid = el("div", { class: "board-grid" }, [
    el("div", { class: "cell header", text: "#" }),
    ...cols.map((c) => el("div", { class: "cell header", text: c }))
  ]);

  grid.appendChild(el("div", { class: "cell header", text: String(row) }));
  for (const c of cols) {
    const isMine = r.mines.includes(c);
    const isX = r.x === c;
    const label = isX ? "X" : isMine ? "•" : "";

    const btn = el("div", { class: "cell btncell text-lg font-bold", text: label });
    btn.title = isX ? "X" : isMine ? "Mina" : "Vazio";
    (btn as HTMLElement).style.borderColor = isX ? "rgba(76,201,240,0.55)" : isMine ? "rgba(255,77,109,0.55)" : "";
    (btn as HTMLElement).style.background = isX ? "rgba(76,201,240,0.12)" : isMine ? "rgba(255,77,109,0.12)" : "";

    btn.addEventListener("click", () => onToggleMine(c));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onSetX(c);
    });
    grid.appendChild(btn);
  }

  const hint = el("div", { class: "muted small text-center" }, [
    "Dica: Clique para mina. Segure (mobile) ou botão direito para X. Ou use botões abaixo."
  ]);

  const xButtons = el("div", { class: "flex flex-col gap-2 mt-2 items-center" }, [
    el("span", { class: "text-sm font-semibold muted", text: "Definir o lugar do 'X':" }),
    el("div", { class: "flex flex-wrap gap-2 justify-center" }, [
      ...cols.map((c) =>
        el(
          "button",
          {
            class: `btn ${r.x === c ? 'btn-primary border-cyan-400/50 outline outline-2 outline-cyan-500/30' : 'btn-secondary shadow-sm'} px-3 py-1 font-mono`,
            onClick: () => onSetX(c)
          },
          [c]
        )
      )
    ]),
  ]);

  return el("div", { class: "flex flex-col gap-4" }, [
    header,
    el("div", { class: "board-wrap flex justify-center" }, [grid]),
    hint,
    xButtons
  ]);
}

function slotClasses(slot: number) {
  return `bg-banner-${slot} text-slot-${slot} text-lg font-black`;
}

function slotAccent(slot: number) {
  return `bg-banner-${slot}`;
}

function slotText(slot: number) {
  return `text-slot-${slot}`;
}

function boardHasAttempt(attemptedByRow: Array<Set<string>> | string[][], row: number, col: string) {
  const idx = row - 1;
  const r = attemptedByRow[idx];
  if (!r) return false;
  if (r instanceof Set) return r.has(col);
  return Array.isArray(r) ? r.includes(col) : false;
}

function dot(slot: number) {
  return dotNode(slot, { mine: false, explode: false, inLegend: true });
}

function dotNode(slot: number, opts: { mine: boolean; explode: boolean; shared?: boolean; inLegend?: boolean }) {
  const wrap = el("span", { class: `dot-wrap ${opts.mine ? "mine-hit" : ""}`.trim() });

  let sizeClass = "";
  if (opts.inLegend) {
    sizeClass = "h-4 w-4";
  } else {
    sizeClass = opts.shared
      ? "h-3.5 w-3.5 sm:h-5 sm:w-5 md:h-6 md:w-6"
      : "h-5 w-5 sm:h-8 sm:w-8 md:h-10 md:w-10";
  }

  const core = el("span", {
    class:
      `${opts.explode ? "explode-dot " : ""}dot-core shrink-0 inline-block ${sizeClass} rounded-full border transition-all ` +
      (slot === 0 ? "bg-dot-0" : "bg-dot-1")
  });
  wrap.appendChild(core);
  if (opts.mine) wrap.appendChild(el("span", { class: "mine-mark" }));
  return wrap;
}

function board10x10Combined(opts: {
  attemptedByRowA: Array<Set<string>> | string[][];
  attemptedByRowB: Array<Set<string>> | string[][];
  mineHitsByRowA: Array<Set<string>> | string[][];
  mineHitsByRowB: Array<Set<string>> | string[][];
  slotA: number;
  slotB: number;
  activeSlot: number;
  active: boolean;
  activeRow: number | null;
  onPick?: (col: string) => void;
  explosion?: { row: number; col: string; slot: number } | null;
  config: GameConfig;
}) {
  const cols = colsForConfig(opts.config);
  const grid = el("div", { class: "board-grid" }, [
    el("div", { class: "cell header", text: "#" }),
    ...cols.map((c) => el("div", { class: "cell header", text: c }))
  ]);

  for (let row = 1; row <= opts.config.rows; row++) {
    const isActiveRow = opts.activeRow === row;
    grid.appendChild(
      el("div", { class: `cell header ${isActiveRow ? "bg-white/10" : ""}`.trim(), text: String(row) })
    );

    for (const col of cols) {
      const triedA = boardHasAttempt(opts.attemptedByRowA, row, col);
      const triedB = boardHasAttempt(opts.attemptedByRowB, row, col);
      const mineA = boardHasAttempt(opts.mineHitsByRowA, row, col);
      const mineB = boardHasAttempt(opts.mineHitsByRowB, row, col);
      const triedByActive = opts.activeSlot === opts.slotA ? triedA : triedB;
      const clickable = !!opts.onPick && opts.active && opts.activeRow === row && !triedByActive;
      const disabled = opts.activeRow !== null && (!opts.active || row !== opts.activeRow || triedByActive);

      const triedClass = triedA && triedB ? "tried-both" : triedA ? "tried-a" : triedB ? "tried-b" : "";
      const selectableClass = clickable ? `selectable selectable-s${opts.activeSlot}` : "";
      const rowClass = isActiveRow ? "active-row" : "";
      const cls = `cell ${clickable ? "btncell" : ""} ${disabled ? "disabled" : ""} ${rowClass} ${triedClass} ${selectableClass} ${triedA || triedB ? "flex items-center justify-center gap-1" : ""
        }`.trim();

      const cell = el("div", { class: cls });
      cell.title = `${col}${row}`;
      const isExplA = !!opts.explosion && opts.explosion.row === row && opts.explosion.col === col && opts.explosion.slot === opts.slotA;
      const isExplB = !!opts.explosion && opts.explosion.row === row && opts.explosion.col === col && opts.explosion.slot === opts.slotB;
      const isShared = triedA && triedB;
      if (triedA) cell.appendChild(dotNode(opts.slotA, { mine: mineA, explode: isExplA, shared: isShared }));
      if (triedB) cell.appendChild(dotNode(opts.slotB, { mine: mineB, explode: isExplB, shared: isShared }));
      if (clickable) cell.addEventListener("click", () => opts.onPick?.(col));
      grid.appendChild(cell);
    }
  }

  return grid;
}

// ---------------------------
// Screens
// ---------------------------
function renderMenu() {
  const nameInput = el("input", {
    class: "input text-center text-lg h-14 font-black tracking-wider uppercase transition-all focus:ring-emerald-500/30 focus:border-emerald-500/50",
    placeholder: "JOGADOR 1",
    value: appState.name,
    onInput: (e: Event) => {
      appState.name = (e.target as HTMLInputElement).value;
      if (appState.ws && appState.ws.readyState === WebSocket.OPEN) {
        const name = (appState.name || "").trim() || "Jogador";
        appState.ws.send(JSON.stringify({ type: "set_name", name }));
      }
    }
  });

  const name2Input = el("input", {
    class: "input text-center text-lg h-14 font-black tracking-wider uppercase transition-all focus:ring-orange-500/30 focus:border-orange-500/50",
    placeholder: "JOGADOR 2",
    value: appState.name2,
    onInput: (e: Event) => {
      appState.name2 = (e.target as HTMLInputElement).value;
    }
  });

  const offlineBtn = el("button", {
    class: "group relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl bg-panel p-6 transition-all hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:-translate-y-1 hover:shadow-[0_10px_40px_-10px_rgba(52,211,153,0.3)]",
    onClick: startOffline
  }, [
    el("div", { class: "text-4xl transition-transform duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_0_15px_rgba(52,211,153,0.8)]" }, ["🎮"]),
    el("div", { class: "flex flex-col items-center gap-1" }, [
      el("span", { class: "text-sm font-black uppercase tracking-widest transition-colors group-hover:text-emerald-500 dark:group-hover:text-emerald-400" }, ["Jogar Local"]),
      el("span", { class: "text-[10px] font-bold tracking-wider uppercase opacity-50" }, ["Mesmo Dispositivo"])
    ])
  ]);

  const onlineBtn = el("button", {
    class: "group relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-2xl bg-panel p-6 transition-all hover:border-cyan-500/50 hover:bg-cyan-500/10 hover:-translate-y-1 hover:shadow-[0_10px_40px_-10px_rgba(34,211,238,0.3)]",
    onClick: () => {
      connectOnline();
      appState.screen = "online_lobby";
      render();
    }
  }, [
    el("div", { class: "text-4xl transition-transform duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_0_15px_rgba(34,211,238,0.8)]" }, ["🌐"]),
    el("div", { class: "flex flex-col items-center gap-1" }, [
      el("span", { class: "text-sm font-black uppercase tracking-widest transition-colors group-hover:text-cyan-600 dark:group-hover:text-cyan-400" }, ["Multiplayer"]),
      el("span", { class: "text-[10px] font-bold tracking-wider uppercase opacity-50" }, ["Salas Online"])
    ])
  ]);

  const setupSection = el("div", { class: "mx-auto flex w-full max-w-lg flex-col gap-8 mt-4" }, [
    el("div", { class: "flex flex-col items-center space-y-2 text-center" }, [
      el("h2", { class: "bg-gradient-to-r from-emerald-500 via-cyan-500 to-orange-500 bg-clip-text text-4xl sm:text-5xl font-black uppercase tracking-tighter text-transparent drop-shadow-sm" }, ["Preparar Batalha"]),
      el("p", { class: "text-sm font-bold uppercase tracking-widest opacity-50" }, ["Defina os nomes e escolha a arena"])
    ]),

    el("div", { class: "grid gap-6 sm:grid-cols-2" }, [
      el("div", { class: "relative flex flex-col gap-2" }, [
        el("div", { class: "absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-emerald-500/30 bg-emerald-100 dark:bg-emerald-950/80 px-3 py-0.5 text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-400 shadow-sm" }, ["Jogador 1"]),
        nameInput
      ]),
      el("div", { class: "relative flex flex-col gap-2" }, [
        el("div", { class: "absolute -top-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-orange-500/30 bg-orange-100 dark:bg-orange-950/80 px-3 py-0.5 text-[10px] font-black uppercase tracking-widest text-orange-700 dark:text-orange-400 shadow-sm" }, ["Jogador 2"]),
        name2Input
      ])
    ]),

    el("div", { class: "flex flex-col gap-3 p-4 rounded-2xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
      el("span", { class: "text-[10px] font-black uppercase tracking-widest opacity-70 text-center" }, ["Configuração da Partida"]),
      el("div", { class: "grid gap-3 grid-cols-3" }, [
        el("div", { class: "flex flex-col gap-1" }, [
          el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Linhas" }),
          el("input", { class: "input text-center h-10 font-bold", type: "number", min: "2", max: String(MAX_ROWS), value: String(appState.pendingConfig.rows), onInput: (e: Event) => { const v = Math.max(2, Math.min(MAX_ROWS, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.rows)); appState.pendingConfig.rows = v; if (appState.pendingConfig.minesPerRow >= v) appState.pendingConfig.minesPerRow = v - 1; render(); } })
        ]),
        el("div", { class: "flex flex-col gap-1" }, [
          el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Minas/Linha" }),
          el("input", { class: "input text-center h-10 font-bold", type: "number", min: "1", max: String(appState.pendingConfig.rows - 1), value: String(appState.pendingConfig.minesPerRow), onInput: (e: Event) => { const v = Math.max(1, Math.min(appState.pendingConfig.rows - 1, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.minesPerRow)); appState.pendingConfig.minesPerRow = v; render(); } })
        ]),
        el("div", { class: "flex flex-col gap-1" }, [
          el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Dano/Mina" }),
          el("input", { class: "input text-center h-10 font-bold", type: "number", min: "1", max: "5", value: String(appState.pendingConfig.mineDamage), onInput: (e: Event) => { const v = Math.max(1, Math.min(5, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.mineDamage)); appState.pendingConfig.mineDamage = v; render(); } })
        ])
      ])
    ]),

    el("div", { class: "flex flex-col gap-4 sm:flex-row mt-2" }, [
      offlineBtn,
      onlineBtn
    ])
  ]);

  const ruleCard = (icon: string, title: string, desc: string, borderColor: string, shadowColor: string) => {
    return el("div", { class: `group relative flex flex-col sm:flex-row items-center sm:items-start gap-4 overflow-hidden rounded-2xl bg-panel border-b-4 sm:border-b sm:border-l-4 ${borderColor} p-5 text-center sm:text-left transition-all hover:-translate-y-1 ${shadowColor}` }, [
      el("div", { class: "text-4xl sm:text-3xl transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6 mt-1" }, [icon]),
      el("div", { class: "flex flex-col" }, [
        el("span", { class: "mb-1 text-sm font-black uppercase tracking-wider" }, [title]),
        el("span", { class: "text-xs leading-relaxed opacity-70" }, [desc])
      ])
    ]);
  };

  const rulesSection = el("div", { class: "mx-auto mt-16 w-full max-w-4xl" }, [
    el("div", { class: "mb-8 flex items-center justify-center gap-4 opacity-50" }, [
      el("div", { class: "h-px w-12 sm:w-32 bg-current" }),
      el("span", { class: "text-xs font-black uppercase tracking-widest" }, ["Como Sobreviver"]),
      el("div", { class: "h-px w-12 sm:w-32 bg-current" })
    ]),
    el("div", { class: "grid gap-5 md:grid-cols-3" }, [
      ruleCard("💣", "Plante Armadilhas", `Oculte ${appState.pendingConfig.minesPerRow} minas e 1 atalho (X) em cada linha inimiga.`, "border-orange-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(251,146,60,0.4)]"),
      ruleCard("🏃", "Ache o Atalho", "Adivinhe onde está o X para descer de linha sem tomar dano.", "border-cyan-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(34,211,238,0.4)]"),
      ruleCard("🏆", "Sobreviva", "Chegue no topo ou faça o adversário perder seus pontos de vida!", "border-emerald-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(52,211,153,0.4)]")
    ])
  ]);

  return el("div", { class: "flex w-full flex-col gap-5 px-2 pb-10 fade-in" }, [
    setupSection,
    rulesSection
  ]);
}

function startOffline() {
  const config = { ...appState.pendingConfig };
  appState.offline = createOfflineGame(config);
  const n = (appState.name || "").trim();
  if (n) appState.offline.players[0].name = n;
  const n2 = (appState.name2 || "").trim();
  appState.offline.players[1].name = n2 || "Jogador 2";
  appState.screen = "offline_setup";
  setLog("Offline: Jogador 1 configura as armadilhas do Jogador 2.");
}

// ─── Shared Layout: Fase de Preparação ─────────────────────────────────────
interface SetupScreenParams {
  config: GameConfig;
  draft: Array<{ row: number; mines: string[]; x: string }>;
  currentRow: number;
  onToggleMine: (col: string) => void;
  onSetX: (col: string) => void;
  onRowChange: (row: number) => void;
  onRandomRow: () => void;
  onRandomAll: () => void;
  submitBtn: Node;
  secondaryBtn: Node;
  statusNote?: string;
  // Cabeçalho
  headerBadges?: Node[];
  title: string;
  subtitle: string;
  // Checklist
  checklistTitle: string;
  checklistExtra?: Node[];
}

function renderSetupScreen(p: SetupScreenParams): Node {
  const rowSel = el(
    "select",
    {
      class: "input w-full flex-1 cursor-pointer font-semibold",
      onChange: (e: Event) => p.onRowChange(Number((e.target as HTMLSelectElement).value))
    },
    Array.from({ length: p.config.rows }, (_, i) => el("option", { value: String(i + 1), text: `Linha ${i + 1}` }))
  );
  (rowSel as HTMLSelectElement).value = String(p.currentRow);

  const randomRowBtn = el("button", {
    class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-3 font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-200 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:border-cyan-500/50 dark:hover:border-cyan-500/30 h-full max-h-min",
    onClick: p.onRandomRow
  }, [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Linha Aleatória"]);

  const randomAllBtn = el("button", {
    class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-3 font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-200 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:border-orange-500/50 dark:hover:border-orange-500/30 h-full max-h-min",
    onClick: p.onRandomAll
  }, [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Tudo Aleatório"]);

  const controlsGroup = el("div", { class: "flex flex-col sm:flex-row gap-4 items-end bg-black/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5" }, [
    el("div", { class: "w-full sm:flex-1" }, [
      el("label", { class: "text-[10px] font-black uppercase tracking-widest opacity-80 dark:opacity-60 mb-2 block pl-1 text-emerald-600 dark:text-emerald-400", text: "Selecionar Linha" }),
      rowSel
    ]),
    el("div", { class: "flex flex-row gap-2 w-full sm:w-auto flex-3" }, [randomRowBtn, randomAllBtn])
  ]);

  const rowEditor = setupRowEditor(p.draft, p.currentRow, p.onToggleMine, p.onSetX, p.config);

  const headerBadgesEl = p.headerBadges && p.headerBadges.length > 0
    ? el("div", { class: "flex flex-wrap items-center gap-2 mb-3 justify-center" }, p.headerBadges)
    : null;

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    el("div", { class: "bg-black/5 dark:bg-black/20 p-4 sm:p-5 border-b border-black/5 dark:border-white/5 text-center relative" }, [
      ...(headerBadgesEl ? [headerBadgesEl] : []),
      el("h2", { class: "text-2xl uppercase tracking-wider muted", text: p.title }),
      el("p", { class: "text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-2 uppercase tracking-widest", text: p.subtitle })
    ]),
    el("div", { class: "p-4 sm:p-6" }, [
      controlsGroup,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      rowEditor,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      el("div", { class: "flex flex-col sm:flex-row gap-3" }, [p.submitBtn, p.secondaryBtn]),
      ...(p.statusNote ? [el("div", { class: "text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-500 text-center mt-4" }, [p.statusNote])] : [])
    ])
  ]);

  const checklistCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg" }, [
    el("div", { class: "flex flex-col sm:flex-row items-start sm:items-center justify-between mb-5 gap-2" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest muted", text: p.checklistTitle }),
      ...(p.checklistExtra ?? [el("span", { class: "text-[10px] font-bold bg-black/5 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/5 text-slate-600 dark:text-slate-400 uppercase tracking-widest", text: `Objetivo: 1X e ${p.config.minesPerRow} Minas / Linha` })])
    ]),
    el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 mb-5" }),
    el("div", { class: "grid gap-3 grid-cols-2 sm:grid-cols-4" }, [
      ...p.draft.map((r) => {
        const xOk = !!r.x;
        const mOk = r.mines.length === p.config.minesPerRow;
        const allOk = xOk && mOk;
        return el("div", { class: `flex flex-col justify-between gap-3 p-3 rounded-xl border transition-all ${allOk ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/30 shadow-[0_0_15px_rgba(52,211,153,0.1)]" : "bg-black/5 dark:bg-black/20 border-black/10 dark:border-white/5"}` }, [
          el("div", { class: "flex items-center justify-between" }, [
            el("span", { class: `font-black text-lg ${allOk ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"}` }, [`L${r.row}`]),
            allOk ? el("span", { class: "text-emerald-600 dark:text-emerald-400 font-black" }, ["✓"]) : el("span", { class: "text-orange-500 font-black" }, ["!"])
          ]),
          el("div", { class: "flex flex-col gap-1" }, [
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${xOk ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-500/30"}`, text: xOk ? `Atalho: ${r.x}` : "Sem Atalho" }),
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${mOk ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-500/30"}`, text: `Minas: ${r.mines.length}/${p.config.minesPerRow}` })
          ])
        ]);
      })
    ])
  ]);

  return el("div", { class: "flex flex-col gap-6 mx-auto w-full animate-in fade-in zoom-in-95 duration-300" }, [
    mainCard,
    checklistCard
  ]);
}

// ─── Shared Layout: Partida ─────────────────────────────────────────────────
interface PlayerInfo {
  name: string;
  slot: number;
  points: number;
  currentRow: number;
}

interface PlayScreenParams {
  config: GameConfig;
  mode: "local" | "online";
  headerRight?: Node;
  activeSlot: number;
  isActive: boolean;
  player0: PlayerInfo;
  player1: PlayerInfo;
  board: Node;
  primaryBtn: Node;
  secondaryBtn: Node;
  progressPlayer0: Node;
  progressPlayer1: Node;
}

function renderPlayScreen(p: PlayScreenParams): Node {
  const activePlayer = p.activeSlot === 0 ? p.player0 : p.player1;
  const bannerSlot = p.isActive ? p.activeSlot : -1; // -1 = sem destaque

  const bannerClass = (slot: number) =>
    slot === 0
      ? "border-emerald-400/50 dark:border-emerald-500/50 shadow-[0_0_15px_rgba(52,211,153,0.1)] bg-emerald-50/50 dark:bg-emerald-500/10"
      : "border-orange-400/50 dark:border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.1)] bg-orange-50/50 dark:bg-orange-500/10";

  const cardClass = (isActive: boolean, slot: number) =>
    isActive ? bannerClass(slot) : "border-black/5 dark:border-white/5 opacity-80";

  const slotColor = (slot: number) =>
    slot === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-orange-600 dark:text-orange-400";

  const slotBar = (slot: number) =>
    slot === 0 ? "bg-emerald-500" : "bg-orange-500";

  const turnLabel = p.isActive
    ? "Turno:"
    : (p.mode === "online" ? "Aguarde:" : "Turno:");
  const turnName = p.isActive
    ? (p.mode === "online" ? "Sua Vez!" : activePlayer.name)
    : (p.mode === "online" ? "Oponente" : activePlayer.name);

  const turnBanner = el("div", { class: `flex flex-col sm:flex-row items-center justify-between p-3 mb-4 rounded-xl border transition-all shadow-sm ${bannerSlot >= 0 ? bannerClass(bannerSlot) : "border-black/5 dark:border-white/5 opacity-80"}` }, [
    el("div", { class: "flex items-center gap-2" }, [
      el("span", { class: "text-[10px] font-black uppercase tracking-widest opacity-70", text: turnLabel }),
      el("span", { class: `text-sm sm:text-lg font-black drop-shadow-md ${p.isActive ? slotColor(p.activeSlot) : "opacity-60"}` }, [turnName])
    ]),
    el("div", { class: "flex items-center gap-2 mt-2 sm:mt-0 bg-black/10 dark:bg-white/10 border border-black/5 dark:border-white/5 px-3 py-1 rounded-lg" }, [
      el("span", { class: `text-[10px] sm:text-xs font-bold uppercase tracking-widest ${p.isActive ? slotColor(p.activeSlot) : "opacity-60"}`, text: `Ataque na Linha ${Math.min(p.config.rows, activePlayer.currentRow)}` })
    ])
  ]);

  const scoreCard = (pl: PlayerInfo, isActive: boolean) =>
    el("div", { class: `flex items-center justify-between p-2 sm:p-3 rounded-xl border bg-black/5 dark:bg-white/5 relative overflow-hidden transition-all ${cardClass(isActive, pl.slot)}` }, [
      el("div", { class: `absolute left-0 top-0 h-full w-1 ${slotBar(pl.slot)}` }),
      el("div", { class: "flex flex-col pl-2" }, [
        el("span", { class: "text-[10px] font-black uppercase tracking-widest truncate max-w-[80px] sm:max-w-full muted", text: pl.name }),
        el("span", { class: `text-[9px] font-bold uppercase tracking-widest opacity-60 ${slotColor(pl.slot)}`, text: `Linha: ${Math.min(p.config.rows, pl.currentRow)}` })
      ]),
      el("div", { class: `flex items-baseline gap-1 text-xl sm:text-2xl font-black ${slotColor(pl.slot)} pr-1` }, [
        el("span", { text: String(pl.points) }),
        el("span", { class: "text-[9px] font-bold uppercase tracking-widest opacity-70 hidden sm:inline", text: "HP" })
      ])
    ]);

  const modeLabel = p.mode === "online" ? "Partida Online" : "Partida Local";
  const modeAccent = p.mode === "online" ? "Arena Online" : "Arena";
  const modeAccentColor = p.mode === "online"
    ? "text-[10px] font-bold text-cyan-600 dark:text-cyan-400 uppercase tracking-widest"
    : "text-[10px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-widest";

  const headerContent = p.headerRight
    ? el("div", { class: "bg-black/5 dark:bg-black/20 p-2 sm:p-3 border-b border-black/5 dark:border-white/5 flex items-center justify-between px-4 gap-2" }, [
      el("span", { class: "text-[10px] sm:text-xs font-black uppercase tracking-wider muted", text: modeLabel }),
      p.headerRight
    ])
    : el("div", { class: "bg-black/5 dark:bg-black/20 p-2 sm:p-3 border-b border-black/5 dark:border-white/5 flex items-center justify-center gap-2" }, [
      el("span", { class: "text-[10px] sm:text-xs font-black uppercase tracking-wider muted", text: modeLabel }),
      el("span", { class: "text-[10px] opacity-30" }, ["•"]),
      el("span", { class: modeAccentColor, text: modeAccent })
    ]);

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    headerContent,
    el("div", { class: "p-3 sm:p-5" }, [
      turnBanner,
      el("div", { class: "grid grid-cols-2 gap-2 sm:gap-4 mb-4" }, [
        scoreCard(p.player0, p.activeSlot === 0 && p.isActive),
        scoreCard(p.player1, p.activeSlot === 1 && p.isActive)
      ]),
      el("div", { class: "flex items-center justify-center gap-4 mb-4 text-[10px] uppercase tracking-widest font-bold opacity-80" }, [
        el("span", { class: "flex items-center gap-1.5" }, [dot(p.player0.slot), el("span", { class: "truncate max-w-[80px] sm:max-w-[120px]", text: p.player0.name })]),
        el("span", { class: "flex items-center gap-1.5" }, [dot(p.player1.slot), el("span", { class: "truncate max-w-[80px] sm:max-w-[120px]", text: p.player1.name })])
      ]),
      el("div", { class: "board-wrap mb-4" }, [p.board]),
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-4" }),
      el("div", { class: "flex flex-col sm:flex-row gap-2" }, [p.primaryBtn, p.secondaryBtn])
    ])
  ]);

  const progressCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg mt-5" }, [
    el("div", { class: "flex items-center justify-between mb-5" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest muted", text: "Status de Avanço" }),
      el("span", { class: "text-[10px] font-bold bg-black/5 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/5 text-slate-600 dark:text-slate-400 uppercase tracking-widest", text: "Progresso Atual" })
    ]),
    el("div", { class: "grid gap-4 sm:grid-cols-2" }, [
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: `text-[10px] font-black uppercase tracking-widest ${slotColor(p.player0.slot)} text-center`, text: p.player0.name }),
        p.progressPlayer0
      ]),
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: `text-[10px] font-black uppercase tracking-widest ${slotColor(p.player1.slot)} text-center`, text: p.player1.name }),
        p.progressPlayer1
      ])
    ])
  ]);

  return el("div", { class: "flex flex-col gap-0 mx-auto w-full animate-in fade-in zoom-in-95 duration-300" }, [
    mainCard,
    progressCard
  ]);
}

// ─── Wrappers Offline ───────────────────────────────────────────────────────
function renderOfflineSetup() {
  const g = appState.offline!;
  const configurador = g.setupStep === 0 ? g.players[0].name : g.players[1].name;
  const alvo = g.setupStep === 0 ? g.players[1].name : g.players[0].name;

  const submitBtn = el("button", {
    class: "group relative flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 p-4 font-black tracking-widest uppercase text-emerald-600 dark:text-emerald-400 transition-all hover:shadow-[0_0_20px_rgba(52,211,153,0.3)] w-full sm:w-auto",
    onClick: offlineSubmitSetup
  }, ["Concluir Setup"]);

  const secondaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 w-full sm:w-auto",
    onClick: () => { appState.screen = "menu"; appState.offline = null; setLog("Voltou ao menu."); }
  }, ["Voltar"]);

  return renderSetupScreen({
    config: g.config,
    draft: g.setupDraft,
    currentRow: g.setupRow,
    onToggleMine: (col) => {
      const r = g.setupDraft[g.setupRow - 1];
      const idx = r.mines.indexOf(col);
      if (idx >= 0) r.mines.splice(idx, 1);
      else {
        if (r.mines.length >= g.config.minesPerRow) return setLog(`Já existem ${g.config.minesPerRow} minas na linha ${r.row}. Remova uma para trocar.`);
        if (r.x === col) return setLog("Essa coluna está marcada como X. Mude o X antes de adicionar mina.");
        r.mines.push(col);
      }
      render();
    },
    onSetX: (col) => {
      const r = g.setupDraft[g.setupRow - 1];
      if (r.mines.includes(col)) return setLog("Essa coluna já é mina. Remova a mina para definir o X.");
      r.x = col; render();
    },
    onRowChange: (row) => { g.setupRow = row; render(); },
    onRandomRow: () => { randomizeDraftRowInPlace(g.setupDraft, g.setupRow, g.config); setLog(`Linha ${g.setupRow} gerada aleatoriamente.`); render(); },
    onRandomAll: () => { randomizeDraftInPlace(g.setupDraft, g.config); g.setupRow = 1; setLog("Todas as linhas foram geradas aleatoriamente."); render(); },
    submitBtn,
    secondaryBtn,
    title: "Fase de Preparação",
    subtitle: `${configurador} armando para ${alvo}`,
    checklistTitle: "Status Tático",
  });
}

function renderOfflinePlay() {
  const g = appState.offline!;
  const pi = g.currentTurnIndex;
  const p = g.players[pi];

  const board = board10x10Combined({
    attemptedByRowA: g.players[0].attemptedByRow,
    attemptedByRowB: g.players[1].attemptedByRow,
    mineHitsByRowA: g.players[0].mineHitsByRow,
    mineHitsByRowB: g.players[1].mineHitsByRow,
    slotA: 0, slotB: 1, activeSlot: pi, active: true,
    activeRow: p.currentRow, onPick: offlineMove,
    explosion: appState.lastExplosion,
    config: g.config
  });

  const primaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 p-4 font-black tracking-widest uppercase text-emerald-600 dark:text-emerald-400 transition-all hover:shadow-[0_0_20px_rgba(52,211,153,0.3)]",
    onClick: () => startOffline()
  }, ["Novo Jogo"]);

  const secondaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10",
    onClick: () => { appState.screen = "menu"; appState.offline = null; setLog("Voltou ao menu."); }
  }, ["Sair da Partida"]);

  return renderPlayScreen({
    config: g.config,
    mode: "local",
    activeSlot: pi,
    isActive: true,
    player0: { name: g.players[0].name, slot: 0, points: g.players[0].points, currentRow: g.players[0].currentRow },
    player1: { name: g.players[1].name, slot: 1, points: g.players[1].points, currentRow: g.players[1].currentRow },
    board,
    primaryBtn,
    secondaryBtn,
    progressPlayer0: progressList(g.players[0].currentRow, g.config),
    progressPlayer1: progressList(g.players[1].currentRow, g.config),
  });
}


function renderOfflineEnd() {
  const g = appState.offline!;
  const winner = g.players[g.winnerIndex ?? 0];
  const reset = el("button", { class: "btn btn-primary", onClick: () => startOffline() }, ["Jogar novamente"]);
  const back = el(
    "button",
    {
      class: "btn btn-secondary",
      onClick: () => {
        appState.screen = "menu";
        appState.offline = null;
        setLog("Voltou ao menu.");
      }
    },
    ["Voltar"]
  );

  return card("Fim de jogo (offline)", [
    el("div", { class: "row" }, [
      el("span", { class: "tag ok", text: `Vencedor: ${winner.name}` }),
      el("span", { class: "tag", text: "Parabéns!" })
    ]),
    el("div", { class: "divider" }),
    el("div", { class: "row" }, [reset, back])
  ]);
}

function renderOnlineLobby() {
  const s = appState.serverState;
  const connected = appState.wsStatus === "connected";
  const inRoom = !!s?.roomCode;

  const nameInput = el("input", {
    class: "input text-center text-lg h-14 font-black tracking-wider uppercase transition-all focus:ring-cyan-500/30 focus:border-cyan-500/50",
    placeholder: "SEU NOME",
    value: appState.name,
    onInput: (e: Event) => (appState.name = (e.target as HTMLInputElement).value)
  });

  const connectBtn = el(
    "button",
    {
      class: `px-3 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-widest transition-all ${connected
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        : appState.wsStatus === "connecting"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
        }`,
      onClick: () => connectOnline(),
      disabled: appState.wsStatus === "connected" || appState.wsStatus === "connecting"
    },
    [appState.wsStatus === "connecting" ? "CONECTANDO..." : connected ? "CONECTADO" : "CONECTAR"]
  );

  const configSection = el("div", { class: "flex flex-col items-center gap-3 mt-6 w-full max-w-sm mx-auto" }, [
    el("span", { class: "text-xs font-black uppercase tracking-widest opacity-70" }, ["Configuração da Partida"]),
    el("div", { class: "grid gap-3 grid-cols-3 w-full" }, [
      el("div", { class: "flex flex-col gap-1" }, [
        el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Linhas" }),
        el("input", { class: "input text-center h-10 font-bold", type: "number", min: "2", max: String(MAX_ROWS), value: String(appState.pendingConfig.rows), onInput: (e: Event) => { const v = Math.max(2, Math.min(MAX_ROWS, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.rows)); appState.pendingConfig.rows = v; if (appState.pendingConfig.minesPerRow >= v) appState.pendingConfig.minesPerRow = v - 1; render(); } })
      ]),
      el("div", { class: "flex flex-col gap-1" }, [
        el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Minas/Linha" }),
        el("input", { class: "input text-center h-10 font-bold", type: "number", min: "1", max: String(appState.pendingConfig.rows - 1), value: String(appState.pendingConfig.minesPerRow), onInput: (e: Event) => { const v = Math.max(1, Math.min(appState.pendingConfig.rows - 1, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.minesPerRow)); appState.pendingConfig.minesPerRow = v; render(); } })
      ]),
      el("div", { class: "flex flex-col gap-1" }, [
        el("label", { class: "text-[9px] font-bold uppercase tracking-widest opacity-60 text-center", text: "Dano/Mina" }),
        el("input", { class: "input text-center h-10 font-bold", type: "number", min: "1", max: "5", value: String(appState.pendingConfig.mineDamage), onInput: (e: Event) => { const v = Math.max(1, Math.min(5, Number((e.target as HTMLInputElement).value) || DEFAULT_CONFIG.mineDamage)); appState.pendingConfig.mineDamage = v; render(); } })
      ])
    ])
  ]);

  const createBtn = el("button", {
    class: "flex items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 p-4 font-black tracking-widest uppercase text-cyan-600 dark:text-cyan-400 transition-all hover:-translate-y-1 hover:shadow-[0_10px_30px_-10px_rgba(34,211,238,0.3)] w-full h-full min-h-[56px]",
    onClick: () => wsSend({ type: "create_room", config: appState.pendingConfig }), disabled: appState.wsStatus === "connecting"
  }, ["Criar Nova Sala"]);

  const roomInput = el("input", {
    class: "input text-center text-lg h-14 font-black tracking-wider uppercase transition-all focus:ring-orange-500/30 focus:border-orange-500/50",
    placeholder: "CÓDIGO (EX: ABCD1)",
    value: appState.roomCodeInput,
    onInput: (e: Event) => {
      appState.roomCodeInput = (e.target as HTMLInputElement).value.toUpperCase();
    },
    onBlur: () => render()
  });

  const joinBtn = el(
    "button",
    {
      class: "flex items-center justify-center rounded-xl border border-orange-500/30 bg-orange-500/10 hover:bg-orange-500/20 p-4 font-black tracking-widest uppercase text-orange-600 dark:text-orange-400 transition-all hover:-translate-y-1 hover:shadow-[0_10px_30px_-10px_rgba(249,115,22,0.3)] w-full mt-2 h-[56px]",
      onClick: () => wsSend({ type: "join_room", roomCode: appState.roomCodeInput }),
      disabled: appState.wsStatus === "connecting" || !appState.roomCodeInput.trim()
    },
    ["Entrar na Sala"]
  );

  const copyBtn = el(
    "button",
    {
      class: "flex items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-3 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 mt-4 w-full text-xs",
      disabled: !inRoom,
      onClick: async () => {
        const code = s?.roomCode;
        if (!code) return;
        try {
          await navigator.clipboard.writeText(code);
          setLog(`Código copiado: ${code}`);
        } catch {
          setLog(`Código da sala: ${code}`);
        }
      }
    },
    ["Copiar Código"]
  );

  const back = el(
    "button",
    {
      class: "flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10",
      onClick: () => {
        appState.screen = "menu";
        setLog("Voltou ao menu.");
      }
    },
    ["← Voltar"]
  );

  const headerControls = el("div", { class: "flex justify-between items-center mb-6" }, [
    back,
    el("div", { class: "flex items-center gap-2" }, [
      connectBtn,
      el("span", { class: `px-3 py-1.5 rounded-lg border text-[10px] font-bold uppercase tracking-widest ${connected ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : appState.wsStatus === "connecting" ? "border-amber-500/30 text-amber-600 dark:text-amber-400" : "border-rose-500/30 text-rose-600 dark:text-rose-400"}`, text: `WS: ${appState.wsStatus}` })
    ])
  ]);

  const nameSection = el("div", { class: "flex flex-col items-center gap-3 mt-6" }, [
    el("span", { class: "text-xs font-black uppercase tracking-widest opacity-70" }, ["1. Identificação"]),
    el("div", { class: "w-full max-w-sm" }, [nameInput]),
    el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-50 text-center" }, ["Você pode atualizar seu nome a qualquer momento."])
  ]);

  const actionsSection = el("div", { class: "grid gap-6 sm:grid-cols-2 mt-8 w-full max-w-2xl mx-auto" }, [
    // Lado esquerdo: Criar
    el("div", { class: "flex flex-col items-center gap-3 p-5 sm:p-6 rounded-2xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
      el("span", { class: "text-xs font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-400" }, ["2. Nova Partida"]),
      el("div", { class: "w-full flex-1 flex flex-col" }, [createBtn]),
      el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-50 text-center mt-2" }, ["Crie e envie o código para um amigo."])
    ]),
    // Lado direito: Juntar
    el("div", { class: "flex flex-col items-center gap-3 p-5 sm:p-6 rounded-2xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
      el("span", { class: "text-xs font-black uppercase tracking-widest text-orange-600 dark:text-orange-400" }, ["Ou 3. Entrar em Sala"]),
      el("div", { class: "w-full flex flex-col" }, [
        roomInput,
        joinBtn
      ])
    ])
  ]);

  const roomInfo = s?.roomCode
    ? el("div", { class: "p-5 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex flex-col items-center gap-3 mt-8 w-full max-w-sm mx-auto shadow-[0_0_20px_rgba(52,211,153,0.15)]" }, [
      el("span", { class: "text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400" }, ["Sala Ativa"]),
      el("div", { class: "text-3xl font-black tracking-widest text-emerald-700 dark:text-emerald-300 drop-shadow-md" }, [s.roomCode]),
      el("div", { class: "flex items-center gap-3 mt-2" }, [
        el("span", { class: "px-2 py-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400" }, [`Jogadores: ${s.playersCount}/2`]),
        el("span", { class: "px-2 py-1 rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400" }, [`Fase: ${s.phase}`])
      ]),
      copyBtn
    ])
    : null;

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-2xl p-4 sm:p-8 w-full mx-auto animate-in fade-in zoom-in-95 duration-300" }, [
    headerControls,
    el("div", { class: "flex flex-col items-center text-center space-y-2 mb-4" }, [
      el("h2", { class: "bg-gradient-to-r from-cyan-500 to-emerald-500 bg-clip-text text-3xl sm:text-4xl font-black uppercase tracking-tighter text-transparent drop-shadow-sm" }, ["Lobby Online"]),
      el("p", { class: "text-[10px] font-bold uppercase tracking-widest opacity-50" }, ["Encontre adversários na rede"])
    ]),
    el("div", { class: "h-px w-full bg-black/5 dark:bg-white/5 my-4" }),
    nameSection,
    configSection,
    actionsSection,
    ...(s?.roomCode ? [roomInfo] : []),
    el("div", { class: "h-px w-full bg-black/5 dark:bg-white/5 my-8" }),
    el("div", { class: "text-[10px] font-bold uppercase tracking-widest opacity-40 text-center" }, [`Config: ${appState.pendingConfig.rows} linhas | ${appState.pendingConfig.minesPerRow} minas/linha | -${appState.pendingConfig.mineDamage} dano/mina`])
  ]);

  const infoCard = el("div", { class: "flex flex-col sm:flex-row items-center gap-4 rounded-2xl bg-panel border-l-4 border-cyan-500/50 p-5 sm:p-6 w-full mx-auto shadow-lg mt-5" }, [
    el("div", { class: "text-3xl" }, ["ℹ️"]),
    el("div", { class: "flex flex-col text-center sm:text-left gap-1" }, [
      el("span", { class: "text-sm font-black uppercase tracking-widest text-cyan-600 dark:text-cyan-400" }, ["Próximo Passo"]),
      el("span", { class: "text-[10px] sm:text-xs font-bold uppercase tracking-wider opacity-70" }, ["Quando 2 jogadores entrarem na mesma sala, iniciarão a fase de Setup. O jogo começa automaticamente assim que os dois terminarem de configurar as minas."])
    ])
  ]);

  return el("div", { class: "flex w-full flex-col gap-0 px-2 pb-10" }, [
    mainCard,
    infoCard
  ]);
}

function renderOnlineSetup() {
  const s = appState.serverState;
  const you = s?.you;
  const opp = s?.opponent;
  if (!s || !you) return renderOnlineLobby();

  const submitBtn = el("button", {
    class: `group relative flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl border p-4 font-black tracking-widest uppercase transition-all w-full sm:w-auto ${you.setupSubmitted ? "border-slate-300 dark:border-slate-500/30 bg-slate-200 dark:bg-slate-500/10 text-slate-500 dark:text-slate-400 cursor-not-allowed" : "border-emerald-300 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_rgba(52,211,153,0.3)]"}`,
    onClick: onlineSubmitSetup,
    disabled: you.setupSubmitted
  }, [you.setupSubmitted ? "Setup Enviado" : "Enviar Setup"]);

  const config = s?.config ?? appState.pendingConfig;
  const secondaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 w-full sm:w-auto",
    onClick: () => { resetOnlineSetup(config); setLog("Setup local resetado."); render(); }
  }, ["Resetar"]);

  const headerBadges = [
    el("span", { class: "text-[10px] font-black uppercase tracking-widest bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-300 dark:border-cyan-500/30 px-3 py-1 rounded", text: `Sala: ${s.roomCode}` }),
    el("span", { class: "text-[10px] font-bold uppercase tracking-widest bg-black/5 dark:bg-black/40 text-slate-600 dark:text-slate-300 border border-black/10 dark:border-white/10 px-3 py-1 rounded", text: `Você: ${you.name}` }),
    el("span", { class: "text-[10px] font-bold uppercase tracking-widest bg-black/5 dark:bg-black/40 text-slate-600 dark:text-slate-300 border border-black/10 dark:border-white/10 px-3 py-1 rounded", text: `Oponente: ${opp?.name || "..."}` })
  ];

  const checklistExtra = [
    el("div", { class: "flex flex-row gap-2" }, [
      el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded border ${you.setupSubmitted ? "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-300 dark:border-amber-500/30"}`, text: you.setupSubmitted ? "Você: Pronto" : "Você: Pendente" }),
      el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded border ${opp?.setupSubmitted ? "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-300 dark:border-amber-500/30"}`, text: opp?.setupSubmitted ? "Oponente: Pronto" : "Oponente: Pendente" })
    ])
  ];

  return renderSetupScreen({
    config,
    draft: onlineSetup.trapsDraft,
    currentRow: onlineSetup.row,
    onToggleMine: (col) => {
      const r = onlineSetup.trapsDraft[onlineSetup.row - 1];
      const idx = r.mines.indexOf(col);
      if (idx >= 0) r.mines.splice(idx, 1);
      else {
        if (r.mines.length >= config.minesPerRow) return setLog(`Já existem ${config.minesPerRow} minas na linha ${r.row}. Remova uma para trocar.`);
        if (r.x === col) return setLog("Essa coluna está marcada como X. Mude o X antes de adicionar mina.");
        r.mines.push(col);
      }
      render();
    },
    onSetX: (col) => {
      const r = onlineSetup.trapsDraft[onlineSetup.row - 1];
      if (r.mines.includes(col)) return setLog("Essa coluna já é mina. Remova a mina para definir o X.");
      r.x = col; render();
    },
    onRowChange: (row) => { onlineSetup.row = row; render(); },
    onRandomRow: () => { randomizeDraftRowInPlace(onlineSetup.trapsDraft, onlineSetup.row, config); setLog(`Linha ${onlineSetup.row} gerada aleatoriamente.`); render(); },
    onRandomAll: () => { randomizeDraftInPlace(onlineSetup.trapsDraft, config); onlineSetup.row = 1; setLog("Todas as linhas foram geradas aleatoriamente."); render(); },
    submitBtn,
    secondaryBtn,
    headerBadges,
    title: "Fase de Preparação",
    subtitle: "Prepare a arena para o adversário",
    checklistTitle: "Status da Sala",
    checklistExtra,
    statusNote: you.setupSubmitted ? "Aguardando oponente enviar o setup..." : "Envie o setup quando terminar."
  });
}

function renderOnlinePlay() {
  const s = appState.serverState!;
  const you = s.you!;
  const opp = s.opponent!;

  const isYourTurn = s.turnPlayerId === you.id;
  const aSlot = Math.min(you.slot, opp.slot);
  const bSlot = aSlot === you.slot ? opp.slot : you.slot;
  const attemptedA = aSlot === you.slot ? you.attemptedByRow : opp.attemptedByRow;
  const attemptedB = bSlot === you.slot ? you.attemptedByRow : opp.attemptedByRow;
  const mineA = aSlot === you.slot ? you.mineHitsByRow : opp.mineHitsByRow;
  const mineB = bSlot === you.slot ? you.mineHitsByRow : opp.mineHitsByRow;

  const config = s.config ?? appState.pendingConfig;
  const board = board10x10Combined({
    attemptedByRowA: attemptedA, attemptedByRowB: attemptedB,
    mineHitsByRowA: mineA, mineHitsByRowB: mineB,
    slotA: aSlot, slotB: bSlot,
    activeSlot: you.slot, active: isYourTurn,
    activeRow: you.currentRow, onPick: onlineMove,
    explosion: appState.lastExplosion,
    config
  });

  const primaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 p-4 font-black tracking-widest uppercase text-cyan-700 dark:text-cyan-400 transition-all hover:shadow-[0_0_20px_rgba(34,211,238,0.3)]",
    onClick: () => wsSend({ type: "reset_room" })
  }, ["Reiniciar (após fim)"]);

  const secondaryBtn = el("button", {
    class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10",
    onClick: () => { appState.screen = "menu"; setLog("Voltou ao menu."); }
  }, ["Sair da Partida"]);

  const roomBadge = el("span", {
    class: "text-[9px] font-bold uppercase tracking-widest bg-black/10 dark:bg-black/40 px-2 py-0.5 rounded border border-black/10 dark:border-white/10 text-slate-600 dark:text-slate-400",
    text: `Sala: ${s.roomCode}`
  });

  // Em modo online, "você" é sempre mostrado na posição do slot (slot 0 = esmeralda, slot 1 = laranja)
  // Para o placar funcionar com renderPlayScreen, precisamos ordenar: player0 = slot 0, player1 = slot 1
  const youIsSlot0 = you.slot === 0;
  const p0 = youIsSlot0
    ? { name: you.name, slot: 0, points: you.points, currentRow: you.currentRow }
    : { name: opp.name, slot: 0, points: opp.points, currentRow: opp.currentRow };
  const p1 = youIsSlot0
    ? { name: opp.name, slot: 1, points: opp.points, currentRow: opp.currentRow }
    : { name: you.name, slot: 1, points: you.points, currentRow: you.currentRow };

  return renderPlayScreen({
    config,
    mode: "online",
    headerRight: roomBadge,
    activeSlot: you.slot,
    isActive: isYourTurn,
    player0: p0,
    player1: p1,
    board,
    primaryBtn,
    secondaryBtn,
    progressPlayer0: progressList(p0.currentRow, config),
    progressPlayer1: progressList(p1.currentRow, config),
  });
}

function renderOnlineEnd() {

  const s = appState.serverState!;
  const you = s.you;
  const winnerId = s.winnerId;
  const winnerName = winnerId === you?.id ? "Você" : winnerId === s.opponent?.id ? s.opponent.name : winnerId ? `Jogador ${winnerId}` : "—";

  const reset = el("button", { class: "btn btn-primary", onClick: () => wsSend({ type: "reset_room" }) }, ["Reiniciar sala"]);
  const back = el(
    "button",
    {
      class: "btn btn-secondary",
      onClick: () => {
        appState.screen = "menu";
        setLog("Voltou ao menu.");
      }
    },
    ["Voltar"]
  );

  return card("Fim de jogo (online)", [
    el("div", { class: "row" }, [
      el("span", { class: "tag ok", text: `Vencedor: ${winnerName}` }),
      el("span", { class: "tag", text: `Sala: ${s.roomCode}` })
    ]),
    el("div", { class: "divider" }),
    el("div", { class: "row" }, [reset, back])
  ]);
}

// ---------------------------
// Render
// ---------------------------
function render() {
  appEl.innerHTML = "";

  let screenEl: Node;
  switch (appState.screen) {
    case "menu":
      screenEl = renderMenu();
      break;
    case "offline_setup":
      screenEl = renderOfflineSetup();
      break;
    case "offline_play":
      screenEl = renderOfflinePlay();
      break;
    case "offline_end":
      screenEl = renderOfflineEnd();
      break;
    case "online_lobby":
      screenEl = renderOnlineLobby();
      break;
    case "online_setup":
      screenEl = renderOnlineSetup();
      break;
    case "online_play":
      screenEl = renderOnlinePlay();
      break;
    case "online_end":
      screenEl = renderOnlineEnd();
      break;
    default:
      screenEl = renderMenu();
  }

  const logBox = el("div", { class: "log", text: appState.log || "Nenhuma atividade recente." });
  const footerRows = document.getElementById("footer-rows");
  if (footerRows) footerRows.textContent = String(appState.pendingConfig.rows);
  appEl.appendChild(screenEl);
  appEl.appendChild(el("div", { class: "w-full mx-auto mt-8 px-2" }, [
    el("div", { class: "flex items-center gap-2 mb-2 opacity-50" }, [
      el("span", { class: "text-[10px] font-black uppercase tracking-widest" }, ["Log do Sistema"])
    ]),
    logBox
  ]));
}

render();
