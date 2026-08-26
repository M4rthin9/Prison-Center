# Prison Commerce - Docker Deployment Guide

## Overview

This project is fully containerized with three services:
- **API** (Node.js + Hono + SQLite)
- **LIFF Frontend** (Static SPA + Caddy)
- **Admin Frontend** (Static SPA + Caddy)

All services are orchestrated with Docker Compose for local development and can be pushed to registries for production.

## Quick Start

### 1. Local Development (Docker Desktop)

```bash
cd docker
docker compose -f compose.local.yml up -d
```

**Access the services:**
- LIFF: http://localhost:5173
- Admin: http://localhost:5174
- API: http://localhost:18787
- API Health: http://localhost:18787/health
- API Docs: http://localhost:18787/api/v1/openapi.json

### 2. Initialize Database

```bash
docker compose -f compose.local.yml exec api pnpm db:seed
```

### 3. View Logs

```bash
# All services
docker compose -f compose.local.yml logs -f

# Specific service
docker compose -f compose.local.yml logs -f api
docker compose -f compose.local.yml logs -f liff
docker compose -f compose.local.yml logs -f admin
```

### 4. Stop Services

```bash
docker compose -f compose.local.yml down
```

## Building Images

### Build All Images Locally

```bash
docker compose -f compose.local.yml build
```

### Build Single Service

```bash
docker compose -f compose.local.yml build api
docker compose -f compose.local.yml build liff
docker compose -f compose.local.yml build admin
```

### Build Without Cache

```bash
docker compose -f compose.local.yml build --no-cache
```

## Image Information

| Service | Image | Size | Base Image |
|---------|-------|------|-----------|
| API | prison-commerce-local-api:latest | ~700MB | node:22-slim |
| LIFF | prison-commerce-local-liff:latest | ~89MB | caddy:2-alpine |
| Admin | prison-commerce-local-admin:latest | ~89MB | caddy:2-alpine |

## Pushing to Registries

### GitHub Container Registry (GHCR)

Automatically pushed by GitHub Actions on push to main branch.

Manual push:
```bash
docker login ghcr.io -u <username> -p <personal-access-token>
docker tag prison-commerce-local-api:latest ghcr.io/<username>/prison-api:latest
docker push ghcr.io/<username>/prison-api:latest
```

### Docker Hub

```bash
./push-to-docker-hub.sh <docker-hub-username>
```

Or manually:
```bash
docker login docker.io
docker tag prison-commerce-local-api:latest <username>/prison-api:latest
docker push <username>/prison-api:latest
```

## CI/CD Setup

### GitHub Actions

Two workflows are configured:

1. **docker.yml** - Existing workflow pushing to GHCR on main push
2. **build-deploy.yml** - New comprehensive workflow with Docker Hub support

#### Configure Docker Hub Secrets (Optional)

In your GitHub repository settings, add:
- `DOCKER_HUB_USERNAME` - Your Docker Hub username
- `DOCKER_HUB_PASSWORD` - Your Docker Hub personal access token

#### Trigger Workflow

```bash
git push origin main
```

Or manually trigger:
```bash
gh workflow run build-deploy.yml
```

## Environment Configuration

### API Environment Variables

See `compose.local.yml` for all environment variables:

```yaml
NODE_ENV: development
PORT: 8787
JWT_SECRET: local-docker-only-secret-change-me-0123456789abcdef
DATABASE_PATH: /data/app.db
STORAGE_LOCAL_DIR: /data/uploads
NOTIFIER_OUTBOX_PATH: /data/outbox.log
```

For production, update these in your deployment configuration.

### Volumes

- **app_data**: Persists database, uploads, and notifier logs

```bash
# View volume location
docker volume inspect prison-commerce-local_app_data

# Backup database
docker run --rm -v prison-commerce-local_app_data:/data -v $(pwd):/backup \
  alpine cp /data/app.db /backup/app.db.backup
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose -f compose.local.yml logs api

# Restart service
docker compose -f compose.local.yml restart api

# Full reset
docker compose -f compose.local.yml down -v
docker compose -f compose.local.yml up -d
```

### Port Already in Use

```bash
# Check what's using the port
lsof -i :5173
lsof -i :5174
lsof -i :18787

# Update port in compose.local.yml
# ports:
#   - "5173:80"  # Change first port to something else
```

### Database Issues

```bash
# Reset database
docker compose -f compose.local.yml exec api rm /data/app.db
docker compose -f compose.local.yml restart api
docker compose -f compose.local.yml exec api pnpm db:seed

# Or use volume
docker volume rm prison-commerce-local_app_data
```

### API Health Check Failing

```bash
# Check API logs
docker compose -f compose.local.yml logs api

# Manual health check
curl http://localhost:18787/health

# Check if API is responding
curl http://localhost:18787/api/v1/openapi.json | head -20
```

## Production Deployment

### Using Docker Compose

1. Update `compose.local.yml` with production settings
2. Use remote images instead of local builds:

```yaml
api:
  image: ghcr.io/<owner>/prison-api:latest
  # Remove build section
```

3. Deploy:

```bash
docker compose up -d
docker compose exec api pnpm db:seed
```

### Using Kubernetes

Convert compose to Kubernetes manifests:

```bash
docker compose config > compose.yaml
kompose convert -f compose.yaml
```

### Health Checks

API has built-in health check:

```bash
curl http://localhost:18787/health
# Expected: {"ok":true,"service":"prison-api","env":"development","now":1787711062637}
```

## Useful Commands

```bash
# View all images
docker images | grep prison

# Inspect container
docker inspect prison-commerce-local-api-1

# Execute commands in container
docker compose exec api pnpm --version
docker compose exec api node --version

# Monitor resource usage
docker stats prison-commerce-local-api-1

# Remove all prison images and volumes
docker system prune -a --volumes

# Check network connectivity
docker compose exec liff ping api:8787
docker compose exec admin ping api:8787
```

## Performance Tips

1. **Layer Caching**: Dockerfiles use multi-stage builds for efficiency
2. **Dependency Caching**: pnpm lock file ensures reproducible builds
3. **Image Optimization**: Frontend images (~89MB) are very small
4. **Volume Performance**: Use named volumes instead of bind mounts for better performance

## Security Notes

⚠️ **Development Only**: Current setup uses:
- Default JWT secret (change for production)
- SQLite database (use PostgreSQL for production)
- No TLS (add reverse proxy with TLS)
- Console notifier (use real notifier for production)

For production:
1. Change all secrets in environment variables
2. Use PostgreSQL or managed database
3. Add reverse proxy (nginx, Caddy, etc.) with TLS
4. Enable proper logging and monitoring
5. Set resource limits
6. Use secrets management (AWS Secrets Manager, HashiCorp Vault, etc.)

## Next Steps

1. ✅ Build and containerize project
2. ✅ Deploy to Docker Desktop
3. ✅ Initialize database
4. ✅ Set up CI/CD with GitHub Actions
5. 🔄 Push to Docker Hub
6. 🔄 Deploy to staging/production
7. 🔄 Set up monitoring and logging
8. 🔄 Configure auto-scaling

## Support

For issues or questions:
1. Check logs: `docker compose logs -f`
2. Review Dockerfile comments
3. Check volume mounts
4. Verify port mappings
5. Test health endpoints

---

**Last Updated**: 2024
**Maintenance**: See GitHub Actions workflows for automated updates
