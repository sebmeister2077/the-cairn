import type { ComponentType } from "react";
import { AddingTranslocatorsWithContributeTLsPost } from "./AddingTranslocatorsWithContributeTLsPost";
import { ContributingToTopsMapPost } from "./ContributingToTopsMapPost";
import { ManagingLandmarksPost } from "./ManagingLandmarksPost";
import { SubmittingTranslocatorScreenshotsPost } from "./SubmittingTranslocatorScreenshotsPost";

export interface BlogPostMeta {
    slug: string;
    title: string;
    excerpt: string;
    date: string; // ISO yyyy-mm-dd
    readingMinutes: number;
    tags: string[];
    Component: ComponentType;
}

// Posts are listed newest-first.
export const BLOG_POSTS: BlogPostMeta[] = [
    {
        slug: "managing-landmarks",
        title: "Adding and Renaming Landmarks",
        excerpt:
            "Add named landmarks to the shared TOPS map, rename your own live, and suggest renames for anyone else's labels — including how pending requests are reviewed by admins.",
        date: "2026-05-22",
        readingMinutes: 5,
        tags: ["guide", "multiplayer", "tops-map", "landmarks"],
        Component: ManagingLandmarksPost,
    },
    {
        slug: "submitting-translocator-screenshots",
        title: "Adding Translocators using Screenshots",
        excerpt:
            "How to take clear endpoint screenshots, upload a TL pair for review, understand analysis status, and read warnings before admin approval.",
        date: "2026-05-15",
        readingMinutes: 7,
        tags: ["guide", "multiplayer", "translocators", "screenshots"],
        Component: SubmittingTranslocatorScreenshotsPost,
    },
    {
        slug: "adding-translocators-using-waypoints",
        title: "Adding Translocators using waypoints",
        excerpt:
            "A step-by-step guide to exporting your spiral waypoints, uploading client-chat.log, reviewing pairings, and submitting TLs to the shared TOPS map.",
        date: "2026-05-08",
        readingMinutes: 6,
        tags: ["guide", "multiplayer", "translocators", "waypoints"],
        Component: AddingTranslocatorsWithContributeTLsPost,
    },
    {
        slug: "contributing-to-the-tops-map",
        title: "Contributing to the TOPS Online Map",
        excerpt:
            "A friendly walkthrough of how player-uploaded map cache files become tiles on the shared TOPS map — and how to make a clean contribution that gets approved.",
        date: "2026-04-28",
        readingMinutes: 7,
        tags: ["guide", "multiplayer", "tops-map"],
        Component: ContributingToTopsMapPost,
    },
];

export function getPostBySlug(slug: string): BlogPostMeta | undefined {
    return BLOG_POSTS.find((p) => p.slug === slug);
}
