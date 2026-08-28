FROM node:22-alpine AS dev

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000

# nodemon --legacy-watch (polling) instead of tsx's native watch: Docker
# Desktop's virtiofs bind mounts don't reliably propagate inotify events.
CMD ["npm", "run", "dev:docker"]
