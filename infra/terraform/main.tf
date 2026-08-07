// AWS infrastructure for FleetView (multi-AZ).
//
// STATUS: `terraform fmt` and `terraform validate` pass (validated against the
// real AWS provider + module schemas), but this has NEVER BEEN APPLIED — no AWS
// account was available. Run `terraform plan` and review the diff carefully
// before applying. Treat as a reviewed starting point, not a turnkey stack.
//
// Cost warning: this provisions NAT gateways (one per AZ), an EKS control
// plane, a Multi-AZ RDS instance and ElastiCache — on the order of hundreds of
// USD/month. The single-VM Docker path in docs/DEPLOYMENT.md is far cheaper and
// is what the Cayman pilot should start with.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.region
}

variable "region" { default = "us-east-1" }
variable "project" { default = "fleetview" }
variable "db_password" {
  type      = string
  sensitive = true
}
// Two AZs minimum so RDS/ElastiCache can fail over.
variable "azs" { default = ["us-east-1a", "us-east-1b"] }

// ---------------------------------------------------------------- networking
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.project
  cidr = "10.0.0.0/16"
  azs  = var.azs

  public_subnets   = ["10.0.1.0/24", "10.0.2.0/24"]   // NLB / ALB
  private_subnets  = ["10.0.11.0/24", "10.0.12.0/24"] // workloads
  database_subnets = ["10.0.21.0/24", "10.0.22.0/24"]

  enable_nat_gateway = true
  single_nat_gateway = false // one per AZ: survives an AZ outage
}

// ------------------------------------------------------------------- compute
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.project
  cluster_version = "1.30"
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets

  eks_managed_node_groups = {
    default = {
      min_size       = 2
      max_size       = 10
      desired_size   = 2
      instance_types = ["t3.large"]
    }
  }
}

// ------------------------------------------------------------------ database
// PostGIS ships with RDS Postgres. TimescaleDB does NOT — if you need the
// hypertable/compression features, either self-manage Postgres on EC2 or use
// Timescale Cloud and point DATABASE_URL at it.
resource "aws_db_instance" "postgres" {
  identifier     = "${var.project}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = "db.t4g.medium"

  allocated_storage     = 100
  max_allocated_storage = 1000
  storage_encrypted     = true

  db_name  = "fleet"
  username = "postgres"
  password = var.db_password

  db_subnet_group_name   = module.vpc.database_subnet_group_name
  vpc_security_group_ids = [aws_security_group.db.id]

  multi_az                  = true // standby in the second AZ
  backup_retention_period   = 14
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.project}-final"
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.project}-redis"
  description                = "FleetView stream bus, allow-list and hot state"
  engine                     = "redis"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2 // primary + replica across AZs
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project}-redis"
  subnet_ids = module.vpc.private_subnets
}

// -------------------------------------------------------------------- access
resource "aws_security_group" "db" {
  name   = "${var.project}-db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "redis" {
  name   = "${var.project}-redis"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

// Device ingestion: raw TCP from anywhere. The NLB itself is created by the
// Kubernetes Service in infra/k8s/ingestion.yaml; this rule lets the traffic
// reach the nodes.
resource "aws_security_group_rule" "device_ingest" {
  type              = "ingress"
  from_port         = 5027
  to_port           = 5027
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = module.eks.node_security_group_id
  description       = "Teltonika device ingestion (raw TCP)"
}

output "cluster_name" { value = module.eks.cluster_name }
output "database_endpoint" { value = aws_db_instance.postgres.endpoint }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
