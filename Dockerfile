### Build stage
FROM node:22-alpine AS build

WORKDIR /app

# Instala dependências primeiro (melhor cache)
COPY package.json package-lock.json ./
RUN npm ci

# Copia o restante do projeto e gera build (frontend + backend)
COPY . .
RUN npm run build

### Runtime stage
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Dependências de produção
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App compilado
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]

