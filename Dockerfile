FROM node:24-alpine AS frontend
WORKDIR /build

COPY ./frontend/package*.json .
RUN npm ci

COPY ./frontend/ .
RUN npm run build


FROM golang:1.25-alpine AS backend
WORKDIR /build

COPY ./backend/go.* .
RUN go mod download -x

COPY ./backend/ .

COPY --from=frontend /build/dist ./dist
# RUN cp -r dist/* . && rm -rf dist
RUN go build -o /dist/backend.bin .


FROM alpine:latest
WORKDIR /app

COPY --from=backend /dist/backend.bin .

CMD ["/app/backend.bin"]
