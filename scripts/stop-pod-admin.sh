set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$ROOT_DIR"

kubectl scale deployment back-admin --replicas=0 -n tp-microservices

echo "Le pod back-admin a été arrêté."