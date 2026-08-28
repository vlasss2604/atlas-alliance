CREATE TABLE "acquired_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"final_url" text NOT NULL,
	"http_status" integer NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"static_text_length" integer,
	"normalized_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"text_sha256" text NOT NULL,
	"render_mode" text DEFAULT 'STATIC' NOT NULL,
	"authority" jsonb NOT NULL,
	"acquiring_job_id" uuid,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_job_id" uuid,
	CONSTRAINT "ck_acquired_documents_text_bounded" CHECK (char_length("normalized_text") <= 2000000)
);--> statement-breakpoint
ALTER TABLE "acquired_documents" ADD CONSTRAINT "acquired_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquired_documents" ADD CONSTRAINT "acquired_documents_acquiring_job_id_research_jobs_id_fk" FOREIGN KEY ("acquiring_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquired_documents" ADD CONSTRAINT "acquired_documents_consumed_by_job_id_research_jobs_id_fk" FOREIGN KEY ("consumed_by_job_id") REFERENCES "public"."research_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_acquired_documents_project" ON "acquired_documents" USING btree ("project_id");
