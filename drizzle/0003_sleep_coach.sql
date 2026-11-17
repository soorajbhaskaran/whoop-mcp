CREATE TABLE "sleep_coach_events" (
	"event_key" text PRIMARY KEY NOT NULL,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
