import type { Locale } from "@/lib/i18n";
import type { ComponentType } from "react";
import { AddingTranslocatorsWithContributeTLsPost } from "./AddingTranslocatorsWithContributeTLsPost";
import { AddingTranslocatorsWithContributeTLsPostRu } from "./AddingTranslocatorsWithContributeTLsPost.ru";
import { ContributingToTopsMapPost } from "./ContributingToTopsMapPost";
import { ContributingToTopsMapPostRu } from "./ContributingToTopsMapPost.ru";
import { ManagingLandmarksPost } from "./ManagingLandmarksPost";
import { ManagingLandmarksPostRu } from "./ManagingLandmarksPost.ru";
import { SubmittingTranslocatorScreenshotsPost } from "./SubmittingTranslocatorScreenshotsPost";
import { SubmittingTranslocatorScreenshotsPostRu } from "./SubmittingTranslocatorScreenshotsPost.ru";

export interface BlogPostMeta {
    slug: string;
    title: string;
    excerpt: string;
    date: string; // ISO yyyy-mm-dd
    readingMinutes: number;
    tags: string[];
    Component: ComponentType;
}

interface BlogPostRecord {
    slug: string;
    date: string;
    readingMinutes: number;
    translations: Record<Locale, Omit<BlogPostMeta, "slug" | "date" | "readingMinutes">>;
}

const BLOG_POSTS: BlogPostRecord[] = [
    {
        slug: "managing-landmarks",
        date: "2026-05-22",
        readingMinutes: 5,
        translations: {
            en: {
                title: "Adding and Renaming Landmarks",
                excerpt:
                    "Add named landmarks to the shared TOPS map, rename your own live, and suggest renames for anyone else's labels - including how pending requests are reviewed by admins.",
                tags: ["guide", "multiplayer", "tops-map", "landmarks"],
                Component: ManagingLandmarksPost,
            },
            ru: {
                title: "Добавление и переименование ориентиров",
                excerpt:
                    "Как добавлять ориентиры на общую карту TOPS, сразу переименовывать свои и предлагать новые имена для чужих меток с админской проверкой заявок.",
                tags: ["гайд", "мультиплеер", "tops-map", "ориентиры"],
                Component: ManagingLandmarksPostRu,
            },
        },
    },
    {
        slug: "submitting-translocator-screenshots",
        date: "2026-05-15",
        readingMinutes: 7,
        translations: {
            en: {
                title: "Adding Translocators using Screenshots",
                excerpt:
                    "How to take clear endpoint screenshots, upload a TL pair for review, understand analysis status, and read warnings before admin approval.",
                tags: ["guide", "multiplayer", "translocators", "screenshots"],
                Component: SubmittingTranslocatorScreenshotsPost,
            },
            ru: {
                title: "Добавление транслокаторов по скриншотам",
                excerpt:
                    "Как сделать понятные скриншоты обоих концов, отправить пару TL на проверку и разобраться в статусах анализа и предупреждениях.",
                tags: ["гайд", "мультиплеер", "транслокаторы", "скриншоты"],
                Component: SubmittingTranslocatorScreenshotsPostRu,
            },
        },
    },
    {
        slug: "adding-translocators-using-waypoints",
        date: "2026-05-08",
        readingMinutes: 6,
        translations: {
            en: {
                title: "Adding Translocators using waypoints",
                excerpt:
                    "A step-by-step guide to exporting your spiral waypoints, uploading client-chat.log, reviewing pairings, and submitting TLs to the shared TOPS map.",
                tags: ["guide", "multiplayer", "translocators", "waypoints"],
                Component: AddingTranslocatorsWithContributeTLsPost,
            },
            ru: {
                title: "Добавление транслокаторов по путевым точкам",
                excerpt:
                    "Пошаговый разбор экспорта spiral-путевых точек, загрузки client-chat.log, проверки пар и отправки TL на общую карту TOPS.",
                tags: ["гайд", "мультиплеер", "транслокаторы", "путевые точки"],
                Component: AddingTranslocatorsWithContributeTLsPostRu,
            },
        },
    },
    {
        slug: "contributing-to-the-tops-map",
        date: "2026-04-28",
        readingMinutes: 7,
        translations: {
            en: {
                title: "Contributing to the TOPS Online Map",
                excerpt:
                    "A friendly walkthrough of how player-uploaded map cache files become tiles on the shared TOPS map - and how to make a clean contribution that gets approved.",
                tags: ["guide", "multiplayer", "tops-map"],
                Component: ContributingToTopsMapPost,
            },
            ru: {
                title: "Как добавлять данные в онлайн-карту TOPS",
                excerpt:
                    "Понятный разбор того, как игроки превращают локальный кэш карты в тайлы общей карты TOPS и как отправить вклад, который одобрят.",
                tags: ["гайд", "мультиплеер", "tops-map"],
                Component: ContributingToTopsMapPostRu,
            },
        },
    },
];

export function getBlogPosts(locale: Locale): BlogPostMeta[] {
    return BLOG_POSTS.map(({ translations, ...post }) => ({
        ...post,
        ...translations[locale],
    }));
}

export function getPostBySlug(locale: Locale, slug: string): BlogPostMeta | undefined {
    const post = BLOG_POSTS.find((entry) => entry.slug === slug);
    if (!post) return undefined;
    return {
        slug: post.slug,
        date: post.date,
        readingMinutes: post.readingMinutes,
        ...post.translations[locale],
    };
}
