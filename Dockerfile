# Minimal, zero-dependency relay. node:alpine keeps the image tiny.
FROM node:22-alpine

WORKDIR /app

# The relay has no runtime dependencies; copy only what it needs to run.
COPY office/relay.mjs ./office/relay.mjs

# State lives on a mounted volume so it survives container restarts.
ENV OFFICE_STATE_PATH=/data/office-state.json \
    OFFICE_HOST=0.0.0.0 \
    OFFICE_PORT=3977
VOLUME ["/data"]

EXPOSE 3977

# Healthcheck hits the unauthenticated /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OFFICE_PORT||3977)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "office/relay.mjs"]
