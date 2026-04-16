import path from "path";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const MINE_DAMAGE = Number(process.env.MINE_DAMAGE || 1);
const ROWS = 8;
const COLS = "ABCDEFGH";
const MINES_PER_ROW = 3;
const INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutos

const app = express();

// Em produção, o Vite gera em dist/public (ver vite.config.ts)
const staticDir = path.join(__dirname, "./");
app.use(express.static(staticDir));

// SPA fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

type Player = { id: string; name: string; ws: WebSocket; lastActivity: number };
type Phase = "waiting" | "setup" | "play" | "finished";

type PlayerState = {
  points: number;
  currentRow: number;
  attemptedByRow: Array<Set<string>>;
  mineHitsByRow: Array<Set<string>>;
};

type TrapRow = { row: number; x: string; mines: string[] };

type Room = {
  code: string;
  players: Player[];
  phase: Phase;
  turnPlayerId: string | null;
  winnerId: string | null;
  playerState: Record<string, PlayerState>;
  setupSubmittedBy: Record<string, boolean>;
  // key = targetPlayerId, value = traps (definidas pelo oponente)
  trapsByTargetPlayerId: Record<string, TrapRow[]>;
};

const rooms = new Map<string, Room>();

function removeInactivePlayers() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const activePlayers = room.players.filter(p => now - p.lastActivity < INACTIVE_TIMEOUT);
    if (activePlayers.length !== room.players.length) {
      // Remover estados dos inativos
      for (const p of room.players) {
        if (!activePlayers.includes(p)) {
          delete room.playerState[p.id];
          delete room.setupSubmittedBy[p.id];
          delete room.trapsByTargetPlayerId[p.id];
        }
      }
      room.players = activePlayers;
      if (room.players.length === 0) {
        rooms.delete(code);
      } else {
        if (room.phase === "play" && room.players.length === 1) {
          const winnerId = room.players[0].id;
          finishGame(room, winnerId);
        }
        for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
      }
    }
  }
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function normalizeRequestedRoomCode(raw: unknown): string | null {
  const code = String(raw || "")
    .trim()
    .toUpperCase();
  if (!code) return null;
  // Permite códigos "humanos" (ex: SALA01). Limite para evitar abuso.
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return "__INVALID__";
  return code;
}

function safeSend(ws: WebSocket, obj: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function getOpponent(room: Room, playerId: string) {
  return room.players.find((p) => p.id !== playerId) || null;
}

function makeInitialPlayerState(): PlayerState {
  return {
    points: 20,
    currentRow: 1,
    attemptedByRow: Array.from({ length: ROWS }, () => new Set<string>()),
    mineHitsByRow: Array.from({ length: ROWS }, () => new Set<string>())
  };
}

function serializeAttempted(attemptedByRow: Array<Set<string>>) {
  return attemptedByRow.map((s) => Array.from(s.values()));
}

function playerSlot(room: Room, playerId: string) {
  return Math.max(0, room.players.findIndex((p) => p.id === playerId));
}

function publicState(room: Room, forPlayerId: string) {
  const you = room.players.find((p) => p.id === forPlayerId) || null;
  const opp = getOpponent(room, forPlayerId);
  return {
    roomCode: room.code,
    phase: room.phase,
    turnPlayerId: room.turnPlayerId,
    you: you
      ? {
          id: you.id,
          name: you.name,
          slot: playerSlot(room, you.id),
          ...room.playerState[you.id],
          attemptedByRow: serializeAttempted(room.playerState[you.id].attemptedByRow),
          mineHitsByRow: serializeAttempted(room.playerState[you.id].mineHitsByRow),
          setupSubmitted: !!room.setupSubmittedBy[you.id]
        }
      : null,
    opponent: opp
      ? {
          id: opp.id,
          name: opp.name,
          slot: playerSlot(room, opp.id),
          points: room.playerState[opp.id].points,
          currentRow: room.playerState[opp.id].currentRow,
          attemptedByRow: serializeAttempted(room.playerState[opp.id].attemptedByRow),
          mineHitsByRow: serializeAttempted(room.playerState[opp.id].mineHitsByRow),
          setupSubmitted: !!room.setupSubmittedBy[opp.id]
        }
      : null,
    playersCount: room.players.length,
    winnerId: room.winnerId || null
  };
}

function validateTrapMap(traps: unknown): string | null {
  // traps: [{row:1, x:"C", mines:["A","B","D","E"]}, ...]
  if (!Array.isArray(traps) || traps.length !== ROWS) return `Mapa inválido: esperado ${ROWS} linhas.`;
  const cols = new Set(COLS.split(""));
  for (const r of traps as any[]) {
    if (!r || typeof r.row !== "number") return "Mapa inválido: linha sem número.";
    if (r.row < 1 || r.row > ROWS) return `Mapa inválido: número de linha fora de 1..${ROWS}.`;
    if (typeof r.x !== "string" || !cols.has(r.x)) return `Mapa inválido: X inválido na linha ${r.row}.`;
    if (!Array.isArray(r.mines) || r.mines.length !== MINES_PER_ROW)
      return `Mapa inválido: esperado ${MINES_PER_ROW} minas na linha ${r.row}.`;
    const mineSet = new Set<string>(r.mines as string[]);
    if (mineSet.size !== MINES_PER_ROW) return `Mapa inválido: minas repetidas na linha ${r.row}.`;
    for (const m of mineSet) {
      if (typeof m !== "string" || !cols.has(m)) return `Mapa inválido: mina inválida (${String(m)}) na linha ${r.row}.`;
    }
    if (mineSet.has(r.x)) return `Mapa inválido: X não pode coincidir com mina na linha ${r.row}.`;
  }
  const rows = new Set((traps as any[]).map((t) => t.row));
  if (rows.size !== ROWS) return "Mapa inválido: linhas repetidas.";
  for (let i = 1; i <= ROWS; i++) if (!rows.has(i)) return `Mapa inválido: faltando linha ${i}.`;
  return null;
}

function startGame(room: Room) {
  room.phase = "play";
  room.turnPlayerId = room.players[Math.floor(Math.random() * room.players.length)].id;
}

function finishGame(room: Room, winnerId: string | null) {
  room.phase = "finished";
  room.winnerId = winnerId;
  room.turnPlayerId = null;
}

wss.on("connection", (ws) => {
  const client: { id: string | null; name: string | null; roomCode: string | null; lastActivity: number } = {
    id: null,
    name: null,
    roomCode: null,
    lastActivity: Date.now()
  };

  safeSend(ws, { type: "connected", mineDamage: MINE_DAMAGE });

  ws.on("message", (raw) => {
    client.lastActivity = Date.now();
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return safeSend(ws, { type: "error", message: "Mensagem inválida (JSON)." });
    }

    try {
      if (client.roomCode) {
        const room = rooms.get(client.roomCode);
        if (room) {
          const player = room.players.find(p => p.id === client.id);
          if (player) player.lastActivity = Date.now();
        }
      }
      if (msg.type === "set_name") {
        client.name = String(msg.name || "").trim().slice(0, 24) || "Jogador";
        return safeSend(ws, { type: "name_ok", name: client.name });
      }

      if (msg.type === "create_room") {
        if (!client.name) client.name = "Jogador";
        const requested = normalizeRequestedRoomCode(msg.roomCode);
        if (requested === "__INVALID__") {
          return safeSend(ws, { type: "error", message: "Código inválido. Use 3–12 caracteres A-Z e 0-9 (sem espaços)." });
        }
        let code: string;
        if (requested) {
          if (rooms.has(requested)) return safeSend(ws, { type: "error", message: "Este código de sala já existe. Tente outro." });
          code = requested;
        } else {
          do code = makeRoomCode();
          while (rooms.has(code));
        }

        client.id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        client.roomCode = code;

        const room: Room = {
          code,
          players: [{ id: client.id, name: client.name, ws, lastActivity: client.lastActivity }],
          phase: "waiting",
          turnPlayerId: null,
          winnerId: null,
          playerState: { [client.id]: makeInitialPlayerState() },
          setupSubmittedBy: { [client.id]: false },
          trapsByTargetPlayerId: {}
        };

        rooms.set(code, room);
        return safeSend(ws, { type: "room_joined", playerId: client.id, state: publicState(room, client.id) });
      }

      if (msg.type === "join_room") {
        if (!client.name) client.name = "Jogador";
        const code = String(msg.roomCode || "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return safeSend(ws, { type: "error", message: "Sala não encontrada." });
        if (room.players.length >= 2) return safeSend(ws, { type: "error", message: "Sala cheia (máximo 2 jogadores)." });
        if (room.phase !== "waiting") return safeSend(ws, { type: "error", message: "Sala já iniciou." });

        client.id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        client.roomCode = code;
        room.players.push({ id: client.id, name: client.name, ws, lastActivity: client.lastActivity });
        room.playerState[client.id] = makeInitialPlayerState();
        room.setupSubmittedBy[client.id] = false;

        room.phase = "setup";

        for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
        return safeSend(ws, { type: "room_joined", playerId: client.id, state: publicState(room, client.id) });
      }

      if (!client.roomCode || !client.id) return safeSend(ws, { type: "error", message: "Você não está em uma sala." });
      const room = rooms.get(client.roomCode);
      if (!room) return safeSend(ws, { type: "error", message: "Sala não existe mais." });

      if (msg.type === "get_state") {
        return safeSend(ws, { type: "room_state", state: publicState(room, client.id) });
      }

      if (msg.type === "setup_submit") {
        if (room.phase !== "setup") return safeSend(ws, { type: "error", message: "Fase inválida para setup." });
        const traps = msg.trapsForOpponent;
        const err = validateTrapMap(traps);
        if (err) return safeSend(ws, { type: "error", message: err });
        const opp = getOpponent(room, client.id);
        if (!opp) return safeSend(ws, { type: "error", message: "Aguardando oponente entrar." });

        room.trapsByTargetPlayerId[opp.id] = traps as TrapRow[];
        room.setupSubmittedBy[client.id] = true;

        if (room.setupSubmittedBy[opp.id]) startGame(room);
        for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
        return;
      }

      if (msg.type === "move") {
        if (room.phase !== "play") return safeSend(ws, { type: "error", message: "A partida não está em andamento." });
        if (room.turnPlayerId !== client.id) return safeSend(ws, { type: "error", message: "Não é o seu turno." });

        const col = String(msg.col || "").toUpperCase();
        if (!COLS.includes(col)) return safeSend(ws, { type: "error", message: `Coluna inválida (A-${COLS[COLS.length - 1]}).` });

        const ps = room.playerState[client.id];
        const row = ps.currentRow;
        if (row < 1 || row > ROWS) return safeSend(ws, { type: "error", message: "Linha atual inválida." });
        const attempted = ps.attemptedByRow[row - 1];
        if (attempted.has(col)) return safeSend(ws, { type: "error", message: "Você já tentou essa coluna nesta linha." });
        attempted.add(col);

        const traps = room.trapsByTargetPlayerId[client.id];
        if (!traps) return safeSend(ws, { type: "error", message: "Mapa de armadilhas não disponível." });
        const rowTrap = traps.find((t) => t.row === row)!;
        const mines = new Set(rowTrap.mines);

        let outcome: "empty" | "mine" | "x" = "empty";
        let pointsLost = 0;
        let gameOver = false;
        let winnerId: string | null = null;

        if (col === rowTrap.x) {
          outcome = "x";
          ps.currentRow = row + 1;
          if (ps.currentRow === ROWS + 1) {
            gameOver = true;
            winnerId = client.id;
            finishGame(room, winnerId);
          }
        } else if (mines.has(col)) {
          outcome = "mine";
          pointsLost = MINE_DAMAGE;
          ps.mineHitsByRow[row - 1].add(col);
          ps.points = Math.max(0, ps.points - MINE_DAMAGE);
          if (ps.points <= 0) {
            gameOver = true;
            const opp = getOpponent(room, client.id);
            winnerId = opp ? opp.id : null;
            finishGame(room, winnerId);
          }
        }

        if (!gameOver) {
          const opp = getOpponent(room, client.id);
          room.turnPlayerId = opp ? opp.id : null;
        }

        for (const p of room.players) {
          safeSend(p.ws, {
            type: "move_result",
            playerId: client.id,
            row,
            col,
            outcome,
            pointsLost,
            yourNewRow: ps.currentRow,
            gameOver,
            winnerId
          });
        }
        for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
        return;
      }

      if (msg.type === "reset_room") {
        if (room.phase !== "finished") return safeSend(ws, { type: "error", message: "Só é possível resetar após terminar." });
        room.phase = "setup";
        room.turnPlayerId = null;
        room.winnerId = null;
        room.trapsByTargetPlayerId = {};
        for (const p of room.players) {
          room.playerState[p.id] = makeInitialPlayerState();
          room.setupSubmittedBy[p.id] = false;
        }
        for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
        return;
      }

      return safeSend(ws, { type: "error", message: "Tipo de mensagem desconhecido." });
    } catch (e: any) {
      return safeSend(ws, { type: "error", message: `Erro no servidor: ${e?.message ? e.message : String(e)}` });
    }
  });

  ws.on("close", () => {
    if (!client.roomCode || !client.id) return;
    const room = rooms.get(client.roomCode);
    if (!room) return;

    room.players = room.players.filter((p) => p.id !== client.id);
    delete room.playerState[client.id];
    delete room.setupSubmittedBy[client.id];
    delete room.trapsByTargetPlayerId[client.id];

    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }

    if (room.phase === "play") {
      const winnerId = room.players[0].id;
      finishGame(room, winnerId);
    }

    for (const p of room.players) safeSend(p.ws, { type: "room_state", state: publicState(room, p.id) });
  });
});

setInterval(removeInactivePlayers, 60 * 1000); // Verificar a cada minuto

server.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Servidor OK em http://localhost:${PORT}`);
});
