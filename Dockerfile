FROM node:22-alpine AS dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# dev:docker runs `tsx watch` with CHOKIDAR_USEPOLLING=true (polling) instead
# of native fs events: Docker Desktop's virtiofs bind mounts don't reliably
# propagate inotify events.
CMD ["npm", "run", "dev:docker"]
