ALTER TABLE "interpretations" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "interpretations" ADD COLUMN "clarification_answer" text;--> statement-breakpoint
ALTER TABLE "interpretations" ADD CONSTRAINT "interpretations_parent_id_interpretations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."interpretations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_interpretations_one_child" ON "interpretations" USING btree ("parent_id") WHERE parent_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_interpretations_user_created" ON "interpretations" USING btree ("user_id","created_at" DESC NULLS LAST);