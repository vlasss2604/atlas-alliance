CREATE TYPE "public"."evidence_entity_binding" AS ENUM('CONFIRMED', 'UNVERIFIED');--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN "entity_binding" "evidence_entity_binding";
