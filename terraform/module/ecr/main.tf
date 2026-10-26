# Private Amazon ECR repositories for the application images

resource "aws_ecr_repository" "repo" {
  for_each = toset(var.repositories)
  name     = each.value
  # A release tag (r<run>-<commit>) always points to the same image. Cosign's signature and
  # attestation tags (sha256-<digest>.sig/.att) are excluded, because signing writes them.
  image_tag_mutability = "IMMUTABLE_WITH_EXCLUSION"
  force_delete         = var.force_delete

  image_tag_mutability_exclusion_filter {
    filter      = "sha256-*"
    filter_type = "WILDCARD"
  }

  image_scanning_configuration {
    scan_on_push = true # basic vulnerability scan on every push
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name = each.value
  }
}

# Keep the last N images, and remove untagged layers after 7 days
resource "aws_ecr_lifecycle_policy" "repo" {
  for_each   = aws_ecr_repository.repo
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after 30 days (SLSA provenance referrers are untagged)"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 30
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep only the most recent release images (signature tags sha256-* are kept)"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["r"]
          countType     = "imageCountMoreThan"
          countNumber   = var.max_image_count
        }
        action = { type = "expire" }
      }
    ]
  })
}
