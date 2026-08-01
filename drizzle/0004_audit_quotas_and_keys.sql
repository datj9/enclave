CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"actor_token_id" uuid,
	"actor_share_link_id" uuid,
	"actor_ip" "inet",
	"artifact_id" uuid,
	"version_id" uuid,
	"share_link_id" uuid,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"user_id" uuid NOT NULL,
	"window_date" date NOT NULL,
	"generations" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_counters_user_id_window_date_pk" PRIMARY KEY("user_id","window_date")
);
--> statement-breakpoint
CREATE TABLE "user_provider_keys" (
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"encrypted_key" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_provider_keys_user_id_provider_pk" PRIMARY KEY("user_id","provider")
);
--> statement-breakpoint
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_keys" ADD CONSTRAINT "user_provider_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_artifact_at_idx" ON "audit_log" USING btree ("artifact_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_at_idx" ON "audit_log" USING btree ("actor_user_id","at" DESC NULLS LAST);