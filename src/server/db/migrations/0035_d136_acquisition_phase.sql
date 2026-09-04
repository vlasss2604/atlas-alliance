CREATE TYPE "public"."research_acquisition_phase" AS ENUM('SEARCHING', 'FETCHING', 'EXTRACTING');--> statement-breakpoint
ALTER TABLE "research_jobs" ADD COLUMN "acquisition_phase" "research_acquisition_phase";--> statement-breakpoint
ALTER TABLE "research_jobs" ADD COLUMN "acquisition_phase_at" timestamp with time zone;