# build the static site
FROM node:20-alpine AS build
WORKDIR /app
# deps layer — cached unless package.json/lock change
COPY package.json package-lock.json ./
RUN npm ci
# source layer — the only thing that rebuilds on app changes
COPY . .
RUN npm run build

# serve it
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
