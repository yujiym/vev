-- SPDX-License-Identifier: AGPL-3.0-or-later
CREATE TABLE `clips` (
	`annotation_status` text NOT NULL,
	`author` text NOT NULL,
	`code` text NOT NULL,
	`commercial_ok` integer NOT NULL,
	`default_bars` integer NOT NULL,
	`density` text,
	`deps` text NOT NULL,
	`derived_from` text,
	`description` text,
	`energy` integer,
	`engine` text NOT NULL,
	`generator` text,
	`id` text PRIMARY KEY NOT NULL,
	`isolated` integer NOT NULL,
	`layer_hint` text,
	`license` text NOT NULL,
	`modified` integer NOT NULL,
	`motion` text,
	`origin` text NOT NULL,
	`original_code` text NOT NULL,
	`palette` text,
	`params` text NOT NULL,
	`reviewed` integer NOT NULL,
	`slug` text NOT NULL,
	`source_url` text,
	`tags` text,
	`thumbnail_key` text,
	`title` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clips_slug_unique` ON `clips` (`slug`);--> statement-breakpoint
CREATE INDEX `clips_engine_idx` ON `clips` (`engine`);--> statement-breakpoint
CREATE INDEX `clips_reviewed_idx` ON `clips` (`reviewed`);--> statement-breakpoint
CREATE INDEX `clips_origin_idx` ON `clips` (`origin`);--> statement-breakpoint
CREATE TABLE `track_items` (
	`bars` integer,
	`clip_id` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`position` integer NOT NULL,
	`section` text,
	`track_id` text NOT NULL,
	`transition_in` text,
	FOREIGN KEY (`clip_id`) REFERENCES `clips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`) REFERENCES `tracks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tracks` (
	`bpm_default` integer,
	`default_transition` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`owner_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`visibility` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_slug_unique` ON `tracks` (`slug`);