# TP Kubernetes - Plateforme Ticketing Microservices

Ce projet implèmente une architecture multi-services cohérente sur Kubernetes:

- Front VueJS
- API Client Express
- API Admin Express
- MinIO (S3 local)
- Redis (cache)
- PostgreSQL (base de donnees)
- Ingress Nginx + Kong API Gateway

Le domaine métier implèmente est un système de ticketing (création, suivi, mise à jour de statut, pièces jointes).

Le front expose maintenant 2 interfaces distinctes:

- Interface User: création de ticket, consultation et upload de fichier sur ticket
- Interface Admin: suivi global, statistiques et mise à jour de statut/assignation

## Structure

- `apps/front`: application VueJS
- `apps/back-client`: API Express connectée à PostgreSQL, Redis, MinIO
- `apps/back-admin`: API Express connectée à PostgreSQL, MinIO
- `k8s/`: ensemble des manifestes Kubernetes detaillés par catégorie (Namespace, ConfigMaps, Ingress, Services, etc.)
- `scripts/build-images.sh`: build local des images applicatives

## Plan d'implementation

1. Developpement des APIs back-client et back-admin avec healthchecks et endpoints metier.
2. Developpement du front Vue connecté aux endpoints exposés via Ingress/Kong.
3. Containerisation des trois applications.
4. Intégration Kubernetes avec ConfigMap, volumes persistants, Services, Ingress et NetworkPolicies.
5. Validation locale des builds et de la syntaxe.

## Prerequis

- Docker
- Node.js 20+
- kubectl
- Un cluster Kubernetes actif
- Un Ingress Controller Nginx installe (namespace `ingress-nginx`)

## Build des images

Depuis la racine du projet:

```bash
./scripts/build-images.sh
```

Equivalent manuel:

```bash
docker build -t tp/back-client:latest apps/back-client
docker build -t tp/back-admin:latest apps/back-admin
docker build -t tp/front:latest apps/front
```

## Charger les images dans le cluster

### Avec kind

```bash
kind load docker-image tp/back-client:latest
kind load docker-image tp/back-admin:latest
kind load docker-image tp/front:latest
```

### Avec minikube

```bash
minikube image load tp/back-client:latest
minikube image load tp/back-admin:latest
minikube image load tp/front:latest
```

## Deploiement

```bash
kubectl apply -f k8s/
kubectl apply -f k8s/04-deployments/
```

Verifier les pods:

```bash
kubectl get pods -n tp-microservices
```

## Acces a la plateforme

Si `ingress-nginx` n'est pas installé, exècute d'abord:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/cloud/deploy.yaml
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=240s
```

Si tu utilises ingress-nginx en local:

```bash
kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller 8080:80
```

Pour couper un pod (afin d'essayer l'accessibilité), voici un exemple de commande

```bash
kubectl scale deployment back-admin --replicas=0 -n tp-microservices
```


Puis:

- Front user: `http://localhost:8080/user`
- Front admin: `http://localhost:8080/admin`
- Health API Client: `http://localhost:8080/api/client/health`
- Health API Admin: `http://localhost:8080/api/admin/health`

## Flux verifies

- `Utilisateur/Admin -> Ingress -> Front`
- `Ingress -> Kong -> /api/client -> back-client`
- `Ingress -> Kong -> /api/admin -> back-admin`
- `back-client -> Redis/PostgreSQL/MinIO`
- `back-admin -> PostgreSQL/MinIO`

## Endpoints principaux

### Back-client

- `GET /health`
- `GET /tickets`
- `GET /tickets/:id`
- `POST /tickets`
- `POST /tickets/cache/refresh`
- `POST /tickets/:id/attachments`
- `GET /tickets/:id/attachments/download`
- `POST /tickets/:id/attachments/sample`

### Back-admin

- `GET /health`
- `GET /tickets`
- `GET /tickets/stats`
- `PATCH /tickets/:id`
- `POST /tickets/:id/attachments`
- `GET /files`
- `POST /tickets/:id/attachments/sample`
