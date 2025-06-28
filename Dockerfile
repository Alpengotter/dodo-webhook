# Используем официальный образ Node.js
FROM node:18-alpine

# Устанавливаем зависимости для сборки и runtime
RUN apk add --no-cache tini curl

# Рабочая директория
WORKDIR /app

# Копируем файлы зависимостей
COPY package.json yarn.lock ./

# Устанавливаем зависимости с кэшированием
RUN --mount=type=cache,target=/root/.yarn \
    yarn install --frozen-lockfile --production && \
    yarn cache clean

# Копируем исходный код
COPY . .

# Устанавливаем права для non-root пользователя
RUN chown -R node:node /app
USER node

# Точка входа с tini для корректной обработки сигналов
ENTRYPOINT ["/sbin/tini", "--"]

# Команда запуска
CMD ["node", "index.js"]

# Экспортируем порт
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s \
  CMD curl -f http://localhost:3000/webhook || exit 1