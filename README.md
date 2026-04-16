# X & Minas — Jogo Multiplayer (PWA)

Jogo de 8×8 (colunas **A–H** e linhas **1–8**) com 2 jogadores, **offline**, **LAN** e **online**.  
Objetivo: **encontrar o “X” de cada linha**, em ordem, até encontrar o último “X” na **linha 8**.

## Regras (implementação)
Como você não respondeu às perguntas de esclarecimento, eu implementei a interpretação mais direta e jogável:

- **Setup secreto:** antes de começar, cada jogador configura, para o **oponente**, em **cada linha**:
  - **3 minas** (colunas) → ao oponente escolher, perde pontos
  - **1 X** (coluna) → ao oponente escolher, **avança para a próxima linha**
- **Turnos alternados:** em seu turno, você escolhe **uma coluna** na **sua linha atual**.
  - Se achar **X**: avança 1 linha
  - Se cair em **mina**: perde **1 ponto** (configurável via `MINE_DAMAGE`)
  - Se não achar nada: permanece na mesma linha
- Cada jogador começa com **20 pontos**. Se chegar a **0**, é eliminado.
- Vence quem:
  - encontra o **X da linha 8** primeiro, **ou**
  - elimina o oponente (zera os pontos).

## Rodar (LAN/online + PWA)
1. Instale dependências:
   ```bash
   npm install
   ```
2. Gere o build (frontend + backend):
   ```bash
   npm run build
   ```
3. Inicie o servidor:
   ```bash
   npm start
   ```
4. Abra no navegador:
   - No mesmo PC: `http://localhost:3000`
   - **LAN:** `http://IP_DO_HOST:3000` (ex.: `http://192.168.0.10:3000`)

> Dica: em celulares/PCs na LAN, use o IP do host. Pode ser necessário liberar a porta 3000 no firewall.

### Online (internet)
Hospede o projeto (Node.js) em qualquer VPS/serviço que rode `node server.js` e exponha a porta HTTP.  
Os jogadores acessam a mesma URL pública e entram no mesmo código de sala.

**Importante (pareamento):** um jogador deve **criar a sala** e compartilhar o **código**; o outro deve **entrar com o mesmo código**.  
Se preferir, digite um código (ex.: `SALA01`) e use **“Criar com código”** no primeiro dispositivo, e **“Entrar na sala”** no segundo.

## GitHub Pages (CI/CD)
Este repositório possui um workflow de **GitHub Actions** que publica o **frontend** no **GitHub Pages** automaticamente.

- Workflow: `.github/workflows/deploy-pages.yml`
- Comando de build do Pages: `npm run build:pages`

> Observação: o GitHub Pages hospeda apenas arquivos estáticos.  
> O modo **Offline** funciona normalmente, mas o modo **Online/LAN** (WebSocket) precisa de um servidor Node.js rodando em outro lugar (VPS, Render, Fly.io, etc.).

## Modo offline (sem servidor)
Ao abrir o jogo, escolha **“Jogar offline (local)”**.  
Esse modo é “hotseat” (2 jogadores no mesmo dispositivo).

## Desenvolvimento (opcional)
Para desenvolver com recarregamento automático:
```bash
npm run dev
```
Isso sobe:
- Vite em `http://localhost:5173` (frontend)
- Servidor WS em `http://localhost:3000` (backend)

> Para testar em outro dispositivo na mesma rede (LAN), use `http://IP_DO_HOST:5173` (frontend) ou rode o build e use `http://IP_DO_HOST:3000` (produção).

## Tailwind CSS 4.x
O Tailwind já está configurado via plugin do Vite (`@tailwindcss/vite`).
- Arquivo: `src/styles.css` (contém `@import "tailwindcss";`)
- Config (opcional): `tailwind.config.ts`

### Interface modernizada
- Fonte principal: **Inter**
- Fonte de destaque (títulos): **Space Grotesk**
- Componentes (cards, botões, inputs, grid) estilizados com **Tailwind v4** via `@apply` em `src/styles.css`

## Controles do Setup
- Clique em uma célula para marcar/desmarcar **mina**.
- Para definir o **X**:
  - PC: clique com botão direito na célula, **ou**
  - use os botões “Definir X” abaixo da linha.
- Alternativa: use **Aleatório (linha)** ou **Aleatório (tudo)** para gerar posições automaticamente.

## Configurações
- Dano da mina:
  ```bash
  MINE_DAMAGE=2 npm start
  ```
