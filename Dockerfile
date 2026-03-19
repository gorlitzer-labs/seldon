# Stage 1: build
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npm run build

# Stage 2: run
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist dist/
COPY --from=build /app/node_modules node_modules/
COPY --from=build /app/package.json .
EXPOSE 7890
CMD ["node", "dist/cli/index.js", "serve", "--room", "default", "--expose"]
