#!/bin/bash
# Push Prison Commerce images to Docker Hub
# Usage: ./push-to-docker-hub.sh <docker-hub-username>

set -e

if [ -z "$1" ]; then
    echo "Usage: ./push-to-docker-hub.sh <docker-hub-username>"
    echo "Example: ./push-to-docker-hub.sh myusername"
    exit 1
fi

DOCKER_HUB_USERNAME="$1"
VERSION="${2:-latest}"
IMAGES=("api" "liff" "admin")

echo "🐳 Pushing Prison Commerce images to Docker Hub..."
echo "Repository: $DOCKER_HUB_USERNAME"
echo "Version: $VERSION"

for image in "${IMAGES[@]}"; do
    local_image="prison-commerce-local-$image:latest"
    remote_image="$DOCKER_HUB_USERNAME/prison-$image:$VERSION"
    
    echo ""
    echo "📦 Pushing $image..."
    echo "  $local_image → $remote_image"
    
    docker tag "$local_image" "$remote_image"
    docker push "$remote_image"
    
    echo "✅ $image pushed successfully"
done

echo ""
echo "✅ All images pushed to Docker Hub!"
echo ""
echo "To use these images:"
echo "  docker pull $DOCKER_HUB_USERNAME/prison-api:$VERSION"
echo "  docker pull $DOCKER_HUB_USERNAME/prison-liff:$VERSION"
echo "  docker pull $DOCKER_HUB_USERNAME/prison-admin:$VERSION"
