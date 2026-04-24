import "./styles.css";

// Config do tabuleiro
const ROWS = 8;
const MINES_PER_ROW = 3;
const COLS = "ABCDEFGH".split("") as Array<string>;

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
  if (btn) btn.textContent = theme === "dark" ? "Escuro" : "Claro";
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
  mineDamage: number;
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
  mineDamage: 1,
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

function newEmptyTraps(): TrapRow[] {
  return Array.from({ length: ROWS }, (_, i) => ({ row: i + 1, x: null, mines: [] }));
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

function randomTrapsAllRows(): TrapRow[] {
  // Para cada linha: 1 X + MINES_PER_ROW minas (todos distintos)
  return Array.from({ length: ROWS }, (_, i) => {
    const row = i + 1;
    const picks = pickDistinct(COLS, MINES_PER_ROW + 1);
    const x = picks[0] ?? "A";
    const mines = picks.slice(1, MINES_PER_ROW + 1);
    return { row, x, mines };
  });
}

function randomizeDraftInPlace(draft: TrapRow[]) {
  const rnd = randomTrapsAllRows();
  for (let i = 0; i < ROWS; i++) {
    draft[i].x = rnd[i].x;
    draft[i].mines = [...rnd[i].mines];
  }
}

function randomizeDraftRowInPlace(draft: TrapRow[], row: number) {
  const picks = pickDistinct(COLS, MINES_PER_ROW + 1);
  const x = picks[0] ?? "A";
  const mines = picks.slice(1, MINES_PER_ROW + 1);
  const r = draft[row - 1];
  if (!r) return;
  r.x = x;
  r.mines = [...mines];
}

function validateTraps(traps: TrapRow[]): string | null {
  if (!Array.isArray(traps) || traps.length !== ROWS) return `É necessário configurar as ${ROWS} linhas.`;
  for (const r of traps) {
    if (!r.x) return `Faltou definir o X na linha ${r.row}.`;
    if (!Array.isArray(r.mines) || r.mines.length !== MINES_PER_ROW)
      return `Faltou definir ${MINES_PER_ROW} minas na linha ${r.row}.`;
    const s = new Set(r.mines);
    if (s.size !== MINES_PER_ROW) return `Minas repetidas na linha ${r.row}.`;
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
  phase: "setup" | "play" | "finished";
  mineDamage: number;
  players: [OfflinePlayer, OfflinePlayer];
  trapsByTargetIndex: Record<number, TrapRow[] | null>;
  currentTurnIndex: 0 | 1;
  winnerIndex: 0 | 1 | null;
  setupStep: 0 | 1;
  setupDraft: TrapRow[];
  setupRow: number;
};

function createOfflineGame(): OfflineGame {
  return {
    phase: "setup",
    mineDamage: 1,
    players: [
      {
        name: "Jogador 1",
        points: 20,
        currentRow: 1,
        attemptedByRow: Array.from({ length: ROWS }, () => new Set()),
        mineHitsByRow: Array.from({ length: ROWS }, () => new Set())
      },
      {
        name: "Jogador 2",
        points: 20,
        currentRow: 1,
        attemptedByRow: Array.from({ length: ROWS }, () => new Set()),
        mineHitsByRow: Array.from({ length: ROWS }, () => new Set())
      }
    ],
    trapsByTargetIndex: { 0: null, 1: null },
    currentTurnIndex: 0,
    winnerIndex: null,
    setupStep: 0,
    setupDraft: newEmptyTraps(),
    setupRow: 1
  };
}

function offlineOpponentIndex(i: 0 | 1): 0 | 1 {
  return i === 0 ? 1 : 0;
}

function offlineSubmitSetup() {
  const g = appState.offline;
  if (!g) return;
  const err = validateTraps(g.setupDraft);
  if (err) return setLog(err);

  const target: 0 | 1 = g.setupStep === 0 ? 1 : 0;
  g.trapsByTargetIndex[target] = cloneTraps(g.setupDraft);

  if (g.setupStep === 0) {
    g.setupStep = 1;
    g.setupDraft = newEmptyTraps();
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
  if (row < 1 || row > ROWS) return;

  const attempted = p.attemptedByRow[row - 1];
  if (attempted.has(col)) return setLog("Você já tentou essa coluna nesta linha.");
  attempted.add(col);

  const traps = g.trapsByTargetIndex[pi];
  if (!traps) return setLog("Erro: armadilhas não configuradas.");
  const rowTrap = traps.find((t) => t.row === row)!;
  const mines = new Set(rowTrap.mines);

  if (col === rowTrap.x) {
    p.currentRow++;
    if (p.currentRow === ROWS + 1) {
      g.phase = "finished";
      g.winnerIndex = pi;
      appState.screen = "offline_end";
      setLog(`${p.name} encontrou o último X e venceu!`);
      return;
    }
    setLog(`${p.name} encontrou o X na linha ${row} e avançou para a linha ${p.currentRow}.`);
  } else if (mines.has(col)) {
    p.points = Math.max(0, p.points - g.mineDamage);
    p.mineHitsByRow[row - 1].add(col);
    triggerExplosion(pi, row, col);
    if (p.points <= 0) {
      g.phase = "finished";
      g.winnerIndex = offlineOpponentIndex(pi);
      appState.screen = "offline_end";
      setLog(`${p.name} caiu em uma mina e ficou sem pontos. ${g.players[g.winnerIndex].name} venceu!`);
      return;
    }
    setLog(`${p.name} caiu em uma mina (-${g.mineDamage}). Pontos agora: ${p.points}.`);
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
      appState.mineDamage = msg.mineDamage ?? 1;
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
  if (s.phase === "setup") appState.screen = "online_setup";
  if (s.phase === "play") appState.screen = "online_play";
  if (s.phase === "finished") appState.screen = "online_end";
}

// online setup draft (client-only)
const onlineSetup: { trapsDraft: TrapRow[]; row: number } = {
  trapsDraft: newEmptyTraps(),
  row: 1
};

function onlineSubmitSetup() {
  const err = validateTraps(onlineSetup.trapsDraft);
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
function progressList(currentRow: number) {
  const items: Node[] = [];
  for (let r = 1; r <= ROWS; r++) {
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
  onSetX: (col: string) => void
) {
  const r = trapsDraft[row - 1];
  const minesLeft = MINES_PER_ROW - r.mines.length;
  const xSet = !!r.x;

  const header = el("div", { class: "flex flex-wrap gap-2 justify-center" }, [
    pill(`Editando L${row}`),
    pill(`Minas restantes: ${Math.max(0, minesLeft)}`),
    pill(`X: ${xSet ? r.x! : "pendente"}`)
  ]);

  const grid = el("div", { class: "board-grid" }, [
    el("div", { class: "cell header", text: "#" }),
    ...COLS.map((c) => el("div", { class: "cell header", text: c }))
  ]);

  grid.appendChild(el("div", { class: "cell header", text: String(row) }));
  for (const c of COLS) {
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
      ...COLS.map((c) =>
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
  slotA: number; // normalmente 0
  slotB: number; // normalmente 1
  activeSlot: number; // 0 ou 1
  active: boolean;
  activeRow: number | null; // linha clicável (ou null para não clicável)
  onPick?: (col: string) => void;
  explosion?: { row: number; col: string; slot: number } | null;
}) {
  const grid = el("div", { class: "board-grid" }, [
    el("div", { class: "cell header", text: "#" }),
    ...COLS.map((c) => el("div", { class: "cell header", text: c }))
  ]);

  for (let row = 1; row <= ROWS; row++) {
    const isActiveRow = opts.activeRow === row;
    grid.appendChild(
      el("div", { class: `cell header ${isActiveRow ? "bg-white/10" : ""}`.trim(), text: String(row) })
    );

    for (const col of COLS) {
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
      ruleCard("💣", "Plante Armadilhas", `Oculte ${MINES_PER_ROW} minas e 1 atalho (X) em cada linha inimiga.`, "border-orange-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(251,146,60,0.4)]"),
      ruleCard("🏃", "Ache o Atalho", "Adivinhe onde está o X para subir de linha sem tomar dano.", "border-cyan-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(34,211,238,0.4)]"),
      ruleCard("🏆", "Sobreviva", "Chegue no topo ou faça o adversário perder seus 20 pontos de vida!", "border-emerald-500/50", "hover:shadow-[0_10px_30px_-10px_rgba(52,211,153,0.4)]")
    ])
  ]);

  return el("div", { class: "flex w-full flex-col gap-5 px-2 pb-10 fade-in" }, [
    setupSection,
    rulesSection
  ]);
}

function startOffline() {
  appState.offline = createOfflineGame();
  const n = (appState.name || "").trim();
  if (n) appState.offline.players[0].name = n;
  const n2 = (appState.name2 || "").trim();
  appState.offline.players[1].name = n2 || "Jogador 2";
  appState.screen = "offline_setup";
  setLog("Offline: Jogador 1 configura as armadilhas do Jogador 2.");
}

function renderOfflineSetup() {
  const g = appState.offline!;
  const configurador = g.setupStep === 0 ? g.players[0].name : g.players[1].name;
  const alvo = g.setupStep === 0 ? g.players[1].name : g.players[0].name;

  const rowSel = el(
    "select",
    {
      class: "input w-full flex-1 cursor-pointer font-semibold",
      onChange: (e: Event) => {
        g.setupRow = Number((e.target as HTMLSelectElement).value);
        render();
      }
    },
    Array.from({ length: ROWS }, (_, i) => el("option", { value: String(i + 1), text: `Linha ${i + 1}` }))
  );
  (rowSel as HTMLSelectElement).value = String(g.setupRow);

  const onToggleMine = (col: string) => {
    const r = g.setupDraft[g.setupRow - 1];
    const idx = r.mines.indexOf(col);
    if (idx >= 0) r.mines.splice(idx, 1);
    else {
      if (r.mines.length >= MINES_PER_ROW)
        return setLog(`Já existem ${MINES_PER_ROW} minas na linha ${r.row}. Remova uma para trocar.`);
      if (r.x === col) return setLog("Essa coluna está marcada como X. Mude o X antes de adicionar mina.");
      r.mines.push(col);
    }
    render();
  };

  const onSetX = (col: string) => {
    const r = g.setupDraft[g.setupRow - 1];
    if (r.mines.includes(col)) return setLog("Essa coluna já é mina. Remova a mina para definir o X.");
    r.x = col;
    render();
  };

  const rowEditor = setupRowEditor(g.setupDraft, g.setupRow, onToggleMine, onSetX);

  const submit = el("button", { class: "group relative flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/20 dark:hover:bg-emerald-500/20 p-4 font-black tracking-widest uppercase text-emerald-600 dark:text-emerald-400 transition-all hover:shadow-[0_0_20px_rgba(52,211,153,0.3)] w-full sm:w-auto", onClick: offlineSubmitSetup }, ["Concluir Setup"]);
  const randomRowBtn = el(
    "button",
    {
      class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-3 font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-200 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:border-cyan-500/50 dark:hover:border-cyan-500/30 h-full max-h-min",
      onClick: () => {
        randomizeDraftRowInPlace(g.setupDraft, g.setupRow);
        setLog(`Linha ${g.setupRow} gerada aleatoriamente.`);
        render();
      }
    },
    [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Aleatório"]
  );
  const randomAllBtn = el(
    "button",
    {
      class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-3 font-bold text-xs uppercase tracking-wider text-slate-700 dark:text-slate-200 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:border-orange-500/50 dark:hover:border-orange-500/30 h-full max-h-min",
      onClick: () => {
        randomizeDraftInPlace(g.setupDraft);
        g.setupRow = 1;
        setLog("Todas as linhas foram geradas aleatoriamente.");
        render();
      }
    },
    [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Surpresa Geral"]
  );
  const back = el(
    "button",
    {
      class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white w-full sm:w-auto",
      onClick: () => {
        appState.screen = "menu";
        appState.offline = null;
        setLog("Voltou ao menu.");
      }
    },
    ["Voltar"]
  );

  const controlsGroup = el("div", { class: "flex flex-col sm:flex-row gap-4 items-end bg-black/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5" }, [
    el("div", { class: "w-full sm:flex-1" }, [
      el("label", { class: "text-[10px] font-black uppercase tracking-widest opacity-80 dark:opacity-60 mb-2 block pl-1 text-emerald-600 dark:text-emerald-400", text: "Selecionar Linha" }),
      rowSel
    ]),
    el("div", { class: "flex flex-row gap-2 w-full sm:w-auto flex-3" }, [
      randomRowBtn,
      randomAllBtn
    ])
  ]);

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    el("div", { class: "bg-black/5 dark:bg-black/20 p-5 border-b border-black/5 dark:border-white/5 text-center relative" }, [
      el("h2", { class: "text-2xl uppercase tracking-wider muted", text: "Fase de Preparação" }),
      el("p", { class: "text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-2 uppercase tracking-widest", text: `${configurador} armando para ${alvo}` })
    ]),
    el("div", { class: "p-4 sm:p-6" }, [
      controlsGroup,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      rowEditor,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      el("div", { class: "flex flex-col sm:flex-row gap-3" }, [submit, back])
    ])
  ]);

  const checklistCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg" }, [
    el("div", { class: "flex flex-col sm:flex-row items-start sm:items-center justify-between mb-5 gap-2" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest muted", text: "Status Tático" }),
      el("span", { class: "text-[10px] font-bold bg-black/5 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/5 text-slate-600 dark:text-slate-400 uppercase tracking-widest", text: `Objetivo: 1X e ${MINES_PER_ROW} Minas / Linha` })
    ]),
    el("div", { class: "grid gap-3 grid-cols-2 sm:grid-cols-4" }, [
      ...g.setupDraft.map((r) => {
        const xOk = !!r.x;
        const mOk = r.mines.length === MINES_PER_ROW;
        const allOk = xOk && mOk;
        return el("div", { class: `flex flex-col justify-between gap-3 p-3 rounded-xl border transition-all ${allOk ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/30 shadow-[0_0_15px_rgba(52,211,153,0.1)]" : "bg-black/5 dark:bg-black/20 border-black/10 dark:border-white/5"}` }, [
          el("div", { class: "flex items-center justify-between" }, [
            el("span", { class: `font-black text-lg ${allOk ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500"}` }, [`L${r.row}`]),
            allOk ? el("span", { class: "text-emerald-600 dark:text-emerald-400 font-black" }, ["✓"]) : el("span", { class: "text-orange-500 font-black" }, ["!"])
          ]),
          el("div", { class: "flex flex-col gap-1" }, [
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${xOk ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-500/30"}`, text: xOk ? `Atalho: ${r.x}` : "Sem Atalho" }),
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${mOk ? "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-500/30"}`, text: `Minas: ${r.mines.length}/${MINES_PER_ROW}` })
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

function renderOfflinePlay() {
  const g = appState.offline!;
  const pi = g.currentTurnIndex;
  const p = g.players[pi];
  const opp = g.players[offlineOpponentIndex(pi)];
  const board = board10x10Combined({
    attemptedByRowA: g.players[0].attemptedByRow,
    attemptedByRowB: g.players[1].attemptedByRow,
    mineHitsByRowA: g.players[0].mineHitsByRow,
    mineHitsByRowB: g.players[1].mineHitsByRow,
    slotA: 0,
    slotB: 1,
    activeSlot: pi,
    active: true,
    activeRow: p.currentRow,
    onPick: offlineMove,
    explosion: appState.lastExplosion
  });

  const reset = el(
    "button",
    {
      class: "flex flex-1 items-center justify-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 dark:bg-emerald-500/10 hover:bg-emerald-500/20 dark:hover:bg-emerald-500/20 p-4 font-black tracking-widest uppercase text-emerald-600 dark:text-emerald-400 transition-all hover:shadow-[0_0_20px_rgba(52,211,153,0.3)]",
      onClick: () => {
        appState.offline = createOfflineGame();
        const n = (appState.name || "").trim();
        if (n) appState.offline.players[0].name = n;
        const n2 = (appState.name2 || "").trim();
        appState.offline.players[1].name = n2 || "Jogador 2";
        appState.screen = "offline_setup";
        setLog("Novo jogo offline: Jogador 1 configura as armadilhas do Jogador 2.");
      }
    },
    ["Novo Jogo"]
  );

  const back = el(
    "button",
    {
      class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white",
      onClick: () => {
        appState.screen = "menu";
        appState.offline = null;
        setLog("Voltou ao menu.");
      }
    },
    ["Sair da Partida"]
  );

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    el("div", { class: "bg-black/5 dark:bg-black/20 p-5 border-b border-black/5 dark:border-white/5 text-center relative flex flex-col items-center" }, [
      el("h2", { class: "text-2xl uppercase tracking-wider muted", text: "Partida Local" }),
      el("p", { class: "text-[10px] font-bold text-emerald-600 dark:text-emerald-400 mt-2 uppercase tracking-widest", text: "Arena de Batalha" })
    ]),
    el("div", { class: "p-4 sm:p-6" }, [
      // Banner de Turno
      el("div", { class: `flex flex-col items-center justify-center p-6 mb-6 rounded-2xl border transition-all shadow-lg bg-banner-${pi}` }, [
        el("span", { class: "text-[10px] font-black uppercase tracking-widest opacity-70 mb-2", text: "Vez do Jogador" }),
        el("div", { class: `text-4xl font-black drop-shadow-md text-center ${slotText(pi)}` }, [p.name]),
        el("div", { class: "mt-4 inline-flex items-center gap-2 bg-black/10 dark:bg-white/10 border border-black/5 dark:border-white/5 px-4 py-1.5 rounded-full" }, [
          el("span", { class: `text-sm font-bold uppercase tracking-widest ${slotText(pi)}`, text: `Linha de Ataque: ${Math.min(ROWS, p.currentRow)}` })
        ]),
        el("span", { class: "text-[10px] font-bold uppercase tracking-widest mt-4 opacity-60 text-center max-w-xs", text: "Clique em uma célula livre na sua linha para avançar." })
      ]),

      // Placar
      el("div", { class: "grid grid-cols-2 gap-4 mb-6" }, [
        // Jogador 1
        el("div", { class: `flex flex-col items-center p-4 rounded-xl border bg-black/5 dark:bg-white/5 relative overflow-hidden transition-all ${pi === 0 ? "border-emerald-400/50 dark:border-emerald-500/50 shadow-[0_0_15px_rgba(52,211,153,0.1)] bg-emerald-50/50 dark:bg-emerald-500/10" : "border-black/5 dark:border-white/5 opacity-80"}` }, [
          el("div", { class: "absolute top-0 left-0 w-full h-1 bg-slot-0" }),
          el("span", { class: "text-xs font-black uppercase tracking-widest truncate w-full text-center mb-2 muted", text: g.players[0].name }),
          el("div", { class: "flex items-baseline gap-1 text-3xl font-black text-slot-0-strong" }, [
            el("span", { text: String(g.players[0].points) }),
            el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-70", text: "HP" })
          ]),
          el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-60 mt-2 text-slot-0-strong", text: `Linha: ${Math.min(ROWS, g.players[0].currentRow)}` })
        ]),
        // Jogador 2
        el("div", { class: `flex flex-col items-center p-4 rounded-xl border bg-black/5 dark:bg-white/5 relative overflow-hidden transition-all ${pi === 1 ? "border-orange-400/50 dark:border-orange-500/50 shadow-[0_0_15px_rgba(249,115,22,0.1)] bg-orange-50/50 dark:bg-orange-500/10" : "border-black/5 dark:border-white/5 opacity-80"}` }, [
          el("div", { class: "absolute top-0 left-0 w-full h-1 bg-slot-1" }),
          el("span", { class: "text-xs font-black uppercase tracking-widest truncate w-full text-center mb-2 muted", text: g.players[1].name }),
          el("div", { class: "flex items-baseline gap-1 text-3xl font-black text-slot-1-strong" }, [
            el("span", { text: String(g.players[1].points) }),
            el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-70", text: "HP" })
          ]),
          el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-60 mt-2 text-slot-1-strong", text: `Linha: ${Math.min(ROWS, g.players[1].currentRow)}` })
        ])
      ]),

      // Legenda
      el("div", { class: "flex flex-wrap items-center justify-center gap-3 mb-6" }, [
        el("span", { class: "text-[10px] font-black opacity-50 uppercase tracking-widest hidden sm:block", text: "Identificação:" }),
        el("span", { class: `flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/5 dark:border-white/5 bg-banner-0 ${slotText(0)}` }, [dot(0), el("span", { class: "text-[10px] font-bold uppercase tracking-widest truncate max-w-[100px]", text: g.players[0].name })]),
        el("span", { class: `flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/5 dark:border-white/5 bg-banner-1 ${slotText(1)}` }, [dot(1), el("span", { class: "text-[10px] font-bold uppercase tracking-widest truncate max-w-[100px]", text: g.players[1].name })])
      ]),

      el("div", { class: "board-wrap mb-6" }, [board]),
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      el("div", { class: "flex flex-col sm:flex-row gap-3" }, [reset, back])
    ])
  ]);

  const progressCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg mt-5" }, [
    el("div", { class: "flex items-center justify-between mb-5" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest muted", text: "Status de Avanço" }),
      el("span", { class: "text-[10px] font-bold bg-black/5 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/5 text-slate-600 dark:text-slate-400 uppercase tracking-widest", text: `Progresso Atual` })
    ]),
    el("div", { class: "grid gap-4 sm:grid-cols-2" }, [
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: "text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 text-center", text: g.players[0].name }),
        progressList(g.players[0].currentRow)
      ]),
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: "text-[10px] font-black uppercase tracking-widest text-orange-600 dark:text-orange-400 text-center", text: g.players[1].name }),
        progressList(g.players[1].currentRow)
      ])
    ])
  ]);

  return el("div", { class: "flex flex-col gap-0 mx-auto w-full animate-in fade-in zoom-in-95 duration-300" }, [
    mainCard,
    progressCard
  ]);
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
    class: "input",
    placeholder: "Seu nome",
    value: appState.name,
    onInput: (e: Event) => (appState.name = (e.target as HTMLInputElement).value)
  });

  const connectBtn = el(
    "button",
    {
      class: "btn btn-primary",
      onClick: () => connectOnline(),
      disabled: appState.wsStatus === "connected" || appState.wsStatus === "connecting"
    },
    [appState.wsStatus === "connecting" ? "Conectando..." : connected ? "Conectado" : "Conectar"]
  );

  const createBtn = el("button", { class: "btn btn-primary", onClick: () => wsSend({ type: "create_room" }), disabled: appState.wsStatus === "connecting" }, [
    "Criar sala"
  ]);

  const roomInput = el("input", {
    class: "input",
    placeholder: "Código da sala (ex: ABCD1)",
    value: appState.roomCodeInput,
    onInput: (e: Event) => {
      appState.roomCodeInput = (e.target as HTMLInputElement).value.toUpperCase();
    },
    onBlur: () => render()
  });

  const joinBtn = el(
    "button",
    {
      class: "btn btn-secondary",
      onClick: () => wsSend({ type: "join_room", roomCode: appState.roomCodeInput }),
      disabled: appState.wsStatus === "connecting" || !appState.roomCodeInput.trim()
    },
    ["Entrar na sala"]
  );

  // Criar usando o código digitado (se houver)
  // const createWithCodeBtn = el(
  //   "button",
  //   {
  //     class: "btn btn-secondary",
  //     onClick: () => wsSend({ type: "create_room", roomCode: appState.roomCodeInput }),
  //     disabled: appState.wsStatus === "connecting" || !appState.roomCodeInput.trim()
  //   },
  //   ["Criar com código"]
  // );

  const copyBtn = el(
    "button",
    {
      class: "btn btn-secondary mt-2",
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
    ["Copiar código"]
  );

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

  const roomInfo = s?.roomCode
    ? el("div", { class: "p-4 bg-white/5 border border-white/10 rounded-lg flex flex-col gap-2 mt-4" }, [
      el("div", { class: "flex items-center gap-2" }, [
        el("span", { class: "tag ok font-bold", text: `Sala: ${s.roomCode}` }),
        el("span", { class: "tag", text: `Jogadores: ${s.playersCount}/2` }),
        el("span", { class: "tag", text: `Fase: ${s.phase}` })
      ])
    ])
    : null;

  const headerControls = el("div", { class: "flex justify-between items-center mb-2" }, [
    back,
    el("div", { class: "flex items-center gap-2" }, [
      connectBtn,
      el("span", { class: `tag ${connected ? "ok" : appState.wsStatus === "connecting" ? "warn" : "danger"}`.trim(), text: `WS: ${appState.wsStatus}` })
    ])
  ]);

  const nameSection = el("div", { class: "flex flex-col gap-2 mt-2" }, [
    el("label", { class: "text-sm font-semibold", text: "1. Seu Nome" }),
    nameInput,
    el("span", { class: "muted small", text: "Você pode atualizar seu nome a qualquer momento." })
  ]);

  const actionsSection = el("div", { class: "grid gap-6 mt-4 sm:grid-cols-2" }, [
    // Lado esquerdo: Criar
    el("div", { class: "flex flex-col gap-3" }, [
      el("span", { class: "text-sm font-semibold", text: "2. Nova Partida" }),
      el("div", { class: "flex-1 flex" }, [
        el("button", { class: "btn btn-primary w-full h-full", onClick: () => wsSend({ type: "create_room" }), disabled: appState.wsStatus === "connecting" }, [
          "Criar Sala"
        ])
      ]),
      el("span", { class: "muted small", text: "Crie e envie o código para um amigo." })
    ]),
    // Lado direito: Juntar
    el("div", { class: "flex flex-col gap-3" }, [
      el("span", { class: "text-sm font-semibold", text: "Ou 3. Entrar em Sala" }),
      el("div", { class: "flex flex-col gap-2" }, [
        roomInput,
        el("button", {
          class: "btn mx-0",
          style: "background: var(--surface-hover); border-color: var(--surface-border);",
          onClick: () => wsSend({ type: "join_room", roomCode: appState.roomCodeInput }),
          disabled: appState.wsStatus === "connecting" || !appState.roomCodeInput.trim()
        }, ["Entrar na Sala"])
      ])
    ])
  ]);

  const mainCard = card("Lobby Online", [
    headerControls,
    el("div", { class: "divider my-4" }),
    nameSection,
    el("div", { class: "divider my-4" }),
    actionsSection,
    ...(s?.roomCode ? [roomInfo, el("div", { class: "mt-2" }, [copyBtn])] : []),
    el("div", { class: "divider my-4" }),
    el("div", { class: "muted small text-center" }, [`Dano da mina nesta partida (servidor): -${appState.mineDamage} ponto(s)`])
  ]);

  const infoCard = card("Próximo passo", [
    el("div", { class: "space-y-2 text-sm muted" }, [
      el("p", {}, ["• Quando 2 jogadores entrarem na mesma sala, iniciarão a fase de Setup."]),
      el("p", {}, ["• O jogo começa automaticamente assim que os dois terminarem de configurar as minas."]),
    ])
  ]);

  return el("div", { class: "flex flex-col gap-5 mx-auto w-full" }, [
    mainCard,
    infoCard
  ]);
}

function renderOnlineSetup() {
  const s = appState.serverState;
  const you = s?.you;
  const opp = s?.opponent;
  if (!s || !you) return renderOnlineLobby();

  const rowSel = el(
    "select",
    {
      class: "input w-full sm:w-auto flex-1 cursor-pointer font-semibold",
      onChange: (e: Event) => {
        onlineSetup.row = Number((e.target as HTMLSelectElement).value);
        render();
      }
    },
    Array.from({ length: ROWS }, (_, i) => el("option", { value: String(i + 1), text: `Linha ${i + 1}` }))
  );
  (rowSel as HTMLSelectElement).value = String(onlineSetup.row);

  const randomRowBtn = el(
    "button",
    {
      class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3 font-bold text-xs uppercase tracking-wider transition-all hover:bg-white/10 hover:border-cyan-500/30 h-full max-h-min",
      onClick: () => {
        randomizeDraftRowInPlace(onlineSetup.trapsDraft, onlineSetup.row);
        setLog(`Linha ${onlineSetup.row} gerada aleatoriamente.`);
        render();
      }
    },
    [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Aleatório"]
  );
  const randomAllBtn = el(
    "button",
    {
      class: "group flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 p-3 font-bold text-xs uppercase tracking-wider transition-all hover:bg-white/10 hover:border-orange-500/30 h-full max-h-min",
      onClick: () => {
        randomizeDraftInPlace(onlineSetup.trapsDraft);
        onlineSetup.row = 1;
        setLog("Todas as linhas foram geradas aleatoriamente.");
        render();
      }
    },
    [el("span", { class: "text-lg transition-transform group-hover:rotate-12" }, ["🎲"]), "Surpresa Geral"]
  );

  const onToggleMine = (col: string) => {
    const r = onlineSetup.trapsDraft[onlineSetup.row - 1];
    const idx = r.mines.indexOf(col);
    if (idx >= 0) r.mines.splice(idx, 1);
    else {
      if (r.mines.length >= MINES_PER_ROW)
        return setLog(`Já existem ${MINES_PER_ROW} minas na linha ${r.row}. Remova uma para trocar.`);
      if (r.x === col) return setLog("Essa coluna está marcada como X. Mude o X antes de adicionar mina.");
      r.mines.push(col);
    }
    render();
  };

  const onSetX = (col: string) => {
    const r = onlineSetup.trapsDraft[onlineSetup.row - 1];
    if (r.mines.includes(col)) return setLog("Essa coluna já é mina. Remova a mina para definir o X.");
    r.x = col;
    render();
  };

  const submit = el("button", {
    class: `group relative flex flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl border p-4 font-black tracking-widest uppercase transition-all w-full sm:w-auto ${you.setupSubmitted ? "border-slate-300 dark:border-slate-500/30 bg-slate-200 dark:bg-slate-500/10 text-slate-500 dark:text-slate-400 cursor-not-allowed" : "border-emerald-300 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 hover:shadow-[0_0_20px_rgba(52,211,153,0.3)]"}`,
    onClick: onlineSubmitSetup,
    disabled: you.setupSubmitted
  }, [
    you.setupSubmitted ? "Setup Enviado" : "Enviar Setup"
  ]);

  const resetDraft = el(
    "button",
    {
      class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white w-full sm:w-auto",
      onClick: () => {
        onlineSetup.trapsDraft = newEmptyTraps();
        onlineSetup.row = 1;
        setLog("Setup local resetado.");
        render();
      }
    },
    ["Resetar"]
  );

  const rowEditor = setupRowEditor(onlineSetup.trapsDraft, onlineSetup.row, onToggleMine, onSetX);

  const controlsGroup = el("div", { class: "flex flex-col sm:flex-row gap-4 items-end bg-black/5 dark:bg-black/20 p-4 rounded-xl border border-black/5 dark:border-white/5" }, [
    el("div", { class: "w-full sm:flex-1" }, [
      el("label", { class: "text-[10px] font-black uppercase tracking-widest opacity-80 dark:opacity-60 mb-2 block pl-1 text-cyan-700 dark:text-cyan-400", text: "Selecionar Linha" }),
      rowSel
    ]),
    el("div", { class: "flex flex-row gap-2 w-full sm:w-auto flex-3" }, [
      randomRowBtn,
      randomAllBtn
    ])
  ]);

  const topStatus = el("div", { class: "flex flex-wrap items-center gap-3 mb-4 justify-center" }, [
    el("span", { class: "text-[10px] font-black uppercase tracking-widest bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border border-cyan-300 dark:border-cyan-500/30 px-3 py-1 rounded", text: `Sala: ${s.roomCode}` }),
    el("span", { class: "text-[10px] font-bold uppercase tracking-widest bg-black/5 dark:bg-black/40 text-slate-600 dark:text-slate-300 border border-black/10 dark:border-white/10 px-3 py-1 rounded", text: `Você: ${you.name}` }),
    el("span", { class: "text-[10px] font-bold uppercase tracking-widest bg-black/5 dark:bg-black/40 text-slate-600 dark:text-slate-300 border border-black/10 dark:border-white/10 px-3 py-1 rounded", text: `Oponente: ${opp?.name || "..."}` })
  ]);

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    el("div", { class: "bg-black/5 dark:bg-black/20 p-5 border-b border-black/5 dark:border-white/5 text-center relative flex flex-col items-center" }, [
      topStatus,
      el("h2", { class: "text-2xl uppercase tracking-wider muted", text: "Fase de Preparação" }),
      el("p", { class: "text-[10px] font-bold text-cyan-700 dark:text-cyan-400 mt-2 uppercase tracking-widest", text: `Prepare a arena para o adversário` })
    ]),
    el("div", { class: "p-4 sm:p-6" }, [
      controlsGroup,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      rowEditor,
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      el("div", { class: "flex flex-col sm:flex-row gap-3" }, [submit, resetDraft]),
      el("div", { class: "text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-500 text-center mt-4" }, [you.setupSubmitted ? "Aguardando oponente enviar o setup..." : "Envie o setup quando terminar."])
    ])
  ]);

  const checklistCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg" }, [
    el("div", { class: "flex flex-col sm:flex-row items-center justify-between mb-5 gap-3" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest text-slate-800 dark:text-slate-200", text: "Status da Sala" }),
      el("div", { class: "flex flex-row gap-2" }, [
        el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded border ${you.setupSubmitted ? "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-300 dark:border-amber-500/30"}`, text: you.setupSubmitted ? "Você: Pronto" : "Você: Pendente" }),
        el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded border ${opp?.setupSubmitted ? "bg-emerald-50 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-500/30" : "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-500 border-amber-300 dark:border-amber-500/30"}`, text: opp?.setupSubmitted ? "Oponente: Pronto" : "Oponente: Pendente" })
      ])
    ]),
    el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 mb-5" }),
    el("div", { class: "grid gap-3 grid-cols-2 sm:grid-cols-4" }, [
      ...onlineSetup.trapsDraft.map((r) => {
        const xOk = !!r.x;
        const mOk = r.mines.length === MINES_PER_ROW;
        const allOk = xOk && mOk;
        return el("div", { class: `flex flex-col justify-between gap-3 p-3 rounded-xl border transition-all ${allOk ? "bg-cyan-50 dark:bg-cyan-500/10 border-cyan-300 dark:border-cyan-500/30 shadow-[0_0_15px_rgba(34,211,238,0.1)]" : "bg-black/5 dark:bg-black/20 border-black/10 dark:border-white/5"}` }, [
          el("div", { class: "flex items-center justify-between" }, [
            el("span", { class: `font-black text-lg ${allOk ? "text-cyan-700 dark:text-cyan-400" : "text-slate-500"}` }, [`L${r.row}`]),
            allOk ? el("span", { class: "text-cyan-600 dark:text-cyan-400 font-black" }, ["✓"]) : el("span", { class: "text-orange-500 font-black" }, ["!"])
          ]),
          el("div", { class: "flex flex-col gap-1" }, [
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${xOk ? "bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/30" : "bg-rose-100 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-300 dark:border-rose-500/30"}`, text: xOk ? `Atalho: ${r.x}` : "Sem Atalho" }),
            el("span", { class: `text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded border text-center ${mOk ? "bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-300 border-cyan-300 dark:border-cyan-500/30" : "bg-amber-100 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-500/30"}`, text: `Minas: ${r.mines.length}/${MINES_PER_ROW}` })
          ])
        ]);
      })
    ]),
    el("div", { class: "text-[10px] font-bold uppercase tracking-widest text-slate-600 dark:text-slate-500 text-center mt-5" }, ["A partida começa automaticamente quando ambos enviarem."])
  ]);

  return el("div", { class: "flex flex-col gap-6 mx-auto w-full animate-in fade-in zoom-in-95 duration-300" }, [
    mainCard,
    checklistCard
  ]);
}

function renderOnlinePlay() {
  const s = appState.serverState!;
  const you = s.you!;
  const opp = s.opponent!;

  const isYourTurn = s.turnPlayerId === you.id;
  // Monta tabuleiro único estilo "planilha", com marcações dos dois jogadores
  // (o "slot" define a cor; o clique só é liberado para o jogador da vez na linha atual dele)
  const aSlot = Math.min(you.slot, opp.slot);
  const bSlot = aSlot === you.slot ? opp.slot : you.slot;
  const attemptedA = aSlot === you.slot ? you.attemptedByRow : opp.attemptedByRow;
  const attemptedB = bSlot === you.slot ? you.attemptedByRow : opp.attemptedByRow;
  const mineA = aSlot === you.slot ? you.mineHitsByRow : opp.mineHitsByRow;
  const mineB = bSlot === you.slot ? you.mineHitsByRow : opp.mineHitsByRow;
  const board = board10x10Combined({
    attemptedByRowA: attemptedA,
    attemptedByRowB: attemptedB,
    mineHitsByRowA: mineA,
    mineHitsByRowB: mineB,
    slotA: aSlot,
    slotB: bSlot,
    activeSlot: you.slot,
    active: isYourTurn,
    activeRow: you.currentRow,
    onPick: onlineMove,
    explosion: appState.lastExplosion
  });

  const reset = el("button", { class: "flex flex-1 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10 dark:bg-cyan-500/10 hover:bg-cyan-500/20 dark:hover:bg-cyan-500/20 p-4 font-black tracking-widest uppercase text-cyan-700 dark:text-cyan-400 transition-all hover:shadow-[0_0_20px_rgba(34,211,238,0.3)]", onClick: () => wsSend({ type: "reset_room" }) }, ["Reiniciar (após fim)"]);
  const back = el(
    "button",
    {
      class: "flex flex-1 items-center justify-center rounded-xl border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 p-4 font-bold tracking-widest uppercase text-slate-600 dark:text-slate-300 transition-all hover:bg-black/10 dark:hover:bg-white/10 hover:text-slate-900 dark:hover:text-white",
      onClick: () => {
        appState.screen = "menu";
        setLog("Voltou ao menu.");
      }
    },
    ["Sair da Partida"]
  );

  const mainCard = el("div", { class: "flex flex-col gap-0 rounded-2xl bg-panel border-black/10 dark:border-white/10 overflow-hidden shadow-xl" }, [
    el("div", { class: "bg-black/5 dark:bg-black/20 p-5 border-b border-black/5 dark:border-white/5 text-center relative flex flex-col items-center" }, [
      el("h2", { class: "text-2xl uppercase tracking-wider muted", text: "Partida Multiplayer" }),
      el("p", { class: "text-[10px] font-bold text-cyan-600 dark:text-cyan-400 mt-2 uppercase tracking-widest", text: "Arena Online" })
    ]),
    el("div", { class: "p-4 sm:p-6" }, [
      // Banner de Turno
      el("div", { class: `relative flex flex-col items-center justify-center p-6 mb-6 rounded-2xl border transition-all shadow-lg ${isYourTurn ? `bg-banner-${you.slot}` : "bg-black/5 dark:bg-white/5 opacity-80"}` }, [
        el("div", { class: "absolute top-3 right-3 hidden sm:block" }, [
          el("span", { class: "text-[10px] font-bold uppercase tracking-wider bg-black/10 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/10 text-slate-600 dark:text-slate-400", text: `Sala: ${s.roomCode}` })
        ]),
        el("span", { class: "text-[10px] font-black uppercase tracking-widest opacity-70 mb-2", text: isYourTurn ? "Ação Requerida" : "Aguardando Oponente" }),
        el("div", { class: `text-4xl font-black drop-shadow-md text-center ${isYourTurn ? slotText(you.slot) : "opacity-60"}` }, [isYourTurn ? "Sua Vez!" : "Vez do Oponente"]),
        el("div", { class: "mt-4 inline-flex items-center gap-2 bg-black/10 dark:bg-white/10 border border-black/5 dark:border-white/5 px-4 py-1.5 rounded-full" }, [
          el("span", { class: `text-sm font-bold uppercase tracking-widest ${isYourTurn ? slotText(you.slot) : "opacity-60"}`, text: `Linha Atual: ${Math.min(ROWS, isYourTurn ? you.currentRow : opp.currentRow)}` })
        ]),
        el("span", { class: "text-[10px] font-bold uppercase tracking-widest mt-4 opacity-60 text-center max-w-xs", text: isYourTurn ? "Clique em uma célula livre na sua linha para avançar." : "Aguarde o outro jogador terminar a jogada." })
      ]),

      // Placar
      el("div", { class: "grid grid-cols-2 gap-4 mb-6" }, [
        // Você
        el("div", { class: `flex flex-col items-center p-4 rounded-xl border bg-black/5 dark:bg-white/5 relative overflow-hidden transition-all ${isYourTurn ? `border-slot-${you.slot} shadow-slot-${you.slot} bg-banner-${you.slot}` : "border-black/5 dark:border-white/5 opacity-80"}` }, [
          el("div", { class: `absolute top-0 left-0 w-full h-1 bg-slot-${you.slot}` }),
          el("span", { class: "text-xs font-black uppercase tracking-widest truncate w-full text-center mb-2 muted", text: "Você" }),
          el("div", { class: `flex items-baseline gap-1 text-3xl font-black text-slot-${you.slot}-strong` }, [
            el("span", { text: String(you.points) }),
            el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-70", text: "HP" })
          ]),
          el("span", { class: `text-[10px] font-bold uppercase tracking-widest opacity-60 mt-2 text-slot-${you.slot}-strong`, text: `Linha: ${Math.min(ROWS, you.currentRow)}` })
        ]),
        // Oponente
        el("div", { class: `flex flex-col items-center p-4 rounded-xl border bg-black/5 dark:bg-white/5 relative overflow-hidden transition-all ${!isYourTurn ? `border-slot-${opp.slot} shadow-slot-${opp.slot} bg-banner-${opp.slot}` : "border-black/5 dark:border-white/5 opacity-80"}` }, [
          el("div", { class: `absolute top-0 left-0 w-full h-1 bg-slot-${opp.slot}` }),
          el("span", { class: "text-xs font-black uppercase tracking-widest truncate w-full text-center mb-2 muted", text: opp.name }),
          el("div", { class: `flex items-baseline gap-1 text-3xl font-black text-slot-${opp.slot}-strong` }, [
            el("span", { text: String(opp.points) }),
            el("span", { class: "text-[10px] font-bold uppercase tracking-widest opacity-70", text: "HP" })
          ]),
          el("span", { class: `text-[10px] font-bold uppercase tracking-widest opacity-60 mt-2 text-slot-${opp.slot}-strong`, text: `Linha: ${Math.min(ROWS, opp.currentRow)}` })
        ])
      ]),

      // Legenda
      el("div", { class: "flex flex-wrap items-center justify-center gap-3 mb-6" }, [
        el("span", { class: "text-[10px] font-black opacity-50 uppercase tracking-widest hidden sm:block", text: "Identificação:" }),
        el("span", { class: `flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/5 dark:border-white/5 bg-banner-${you.slot} ${slotText(you.slot)}` }, [dot(you.slot), el("span", { class: "text-[10px] font-bold uppercase tracking-widest truncate max-w-[100px]", text: "Você" })]),
        el("span", { class: `flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/5 dark:border-white/5 bg-banner-${opp.slot} ${slotText(opp.slot)}` }, [dot(opp.slot), el("span", { class: "text-[10px] font-bold uppercase tracking-widest truncate max-w-[100px]", text: opp.name })])
      ]),

      el("div", { class: "board-wrap mb-6" }, [board]),
      el("div", { class: "h-px w-full bg-black/10 dark:bg-white/5 my-6" }),
      el("div", { class: "flex flex-col sm:flex-row gap-3" }, [reset, back])
    ])
  ]);

  const progressCard = el("div", { class: "flex flex-col rounded-2xl bg-panel p-4 sm:p-6 border-black/10 dark:border-white/10 shadow-lg mt-5" }, [
    el("div", { class: "flex items-center justify-between mb-5" }, [
      el("h3", { class: "text-sm font-black uppercase tracking-widest muted", text: "Status de Avanço" }),
      el("span", { class: "text-[10px] font-bold bg-black/5 dark:bg-black/40 px-2 py-1 rounded border border-black/10 dark:border-white/5 text-slate-600 dark:text-slate-400 uppercase tracking-widest", text: `Progresso Atual` })
    ]),
    el("div", { class: "grid gap-4 sm:grid-cols-2" }, [
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: `text-[10px] font-black uppercase tracking-widest text-center ${slotText(you.slot)}`, text: you.name }),
        progressList(you.currentRow)
      ]),
      el("div", { class: "flex flex-col gap-2 p-3 rounded-xl bg-black/5 dark:bg-black/20 border border-black/5 dark:border-white/5" }, [
        el("span", { class: `text-[10px] font-black uppercase tracking-widest text-center ${slotText(opp.slot)}`, text: opp.name }),
        progressList(opp.currentRow)
      ])
    ])
  ]);

  return el("div", { class: "flex flex-col gap-0 mx-auto w-full max-w-2xl animate-in fade-in zoom-in-95 duration-300" }, [
    mainCard,
    progressCard
  ]);
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
  appEl.appendChild(screenEl);
  appEl.appendChild(el("div", { class: "w-full mx-auto mt-8 px-2" }, [
    el("div", { class: "flex items-center gap-2 mb-2 opacity-50" }, [
      el("span", { class: "text-[10px] font-black uppercase tracking-widest" }, ["Log do Sistema"])
    ]),
    logBox
  ]));
}

render();
