REGISTRY  := pi-1.local:5000
IMAGE     := $(REGISTRY)/audio-sketchbook
TAG       := latest
NAMESPACE := audio-sketchbook
HOST      := pi-1.local
PORT      := 30087

.PHONY: help all build push secret deploy restart logs backup restore install run

help:
	@echo ""
	@echo "  audio-sketchbook"
	@echo ""
	@echo "  make all        Build, push, and deploy"
	@echo "  make build      Build linux/arm64 Docker image"
	@echo "  make push       Push image to $(REGISTRY)"
	@echo "  make deploy     Apply k8s manifests (namespace, pvc, deployment, service)"
	@echo "  make restart    Rolling restart of the deployment"
	@echo "  make logs       Tail pod logs"
	@echo "  make backup     Download a backup zip to the current directory"
	@echo "  make restore    Restore from zip: make restore FILE=audio-sketchbook-*.zip"
	@echo "  make install    Create local venv and install Python deps"
	@echo "  make run        Run locally on http://localhost:8765"
	@echo ""

all: build push deploy

build:
	docker build --platform linux/arm64 -t $(IMAGE):$(TAG) .

push:
	docker push $(IMAGE):$(TAG)

secret:
	@echo "No secrets required for this app."

deploy:
	kubectl apply -f k8s/namespace.yaml
	kubectl apply -f k8s/pvc.yaml
	kubectl apply -f k8s/deployment.yaml
	kubectl apply -f k8s/service.yaml

restart:
	kubectl rollout restart deployment/audio-sketchbook -n $(NAMESPACE)

logs:
	kubectl logs -f -l app=audio-sketchbook -n $(NAMESPACE)

backup:
	curl -fO http://$(HOST):$(PORT)/backup

restore:
	@test -n "$(FILE)" || (echo "ERROR: FILE is not set. Usage: make restore FILE=audio-sketchbook-<ts>.zip" && exit 1)
	curl -f -X POST http://$(HOST):$(PORT)/restore -F "file=@$(FILE)"

install:
	python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

run:
	.venv/bin/uvicorn main:app --reload --port 8765
