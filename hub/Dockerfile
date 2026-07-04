# Minimal, zero-dependency relay hub. node:alpine keeps the image tiny.
# Build context is this hub/ directory.
FROM node:22-alpine

WORKDIR /app

# The hub has no runtime dependencies; copy only what it needs to run.
COPY relay.mjs ./relay.mjs

# State + uploaded files live on a mounted volume so they survive restarts.
ENV OFFICE_STATE_PATH=/data/office-state.json \
    OFFICE_FILES_PATH=/data/files \
    OFFICE_HOST=0.0.0.0 \
    OFFICE_PORT=3977
VOLUME ["/data"]

EXPOSE 3977

# Healthcheck hits the unauthenticated /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OFFICE_PORT||3977)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay.mjs"]
