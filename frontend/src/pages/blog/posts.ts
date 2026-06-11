import type { Locale } from "@/lib/i18n";
import type { ComponentType } from "react";
import { AddingTranslocatorsWithContributeTLsPost } from "./AddingTranslocatorsWithContributeTLsPost";
import { AddingTranslocatorsWithContributeTLsPostRu } from "./AddingTranslocatorsWithContributeTLsPost.ru";
import { ContributingElkWalkableRoadsPost } from "./ContributingElkWalkableRoadsPost";
import { ContributingElkWalkableRoadsPostRu } from "./ContributingElkWalkableRoadsPost.ru";
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
        slug: "contributing-elk-walkable-roads",
        date: "2026-06-02",
        readingMinutes: 5,
        translations: {
            en: {
                title: "Submitting Elk-walkable Roads",
                excerpt:
                    "Turn on the elk-walkable preference, read the new time-range estimates, and attest the walking shortcuts your elk can actually cross so the planner trusts them at full speed.",
                tags: ["guide", "multiplayer", "route-planner", "elk-walkable"],
                Component: ContributingElkWalkableRoadsPost,
            },
            ru: {
                title: "Заверение «лосиных» пеших срезок",
                excerpt:
                    "Включите предпочтение лосиных маршрутов, разберитесь с интервалом оценки времени и заверяйте пешие срезки, которые ваш лось реально проходит, чтобы планировщик доверял им на полной скорости.",
                tags: ["гайд", "мультиплеер", "маршруты", "лось"],
                Component: ContributingElkWalkableRoadsPostRu,
            },
            es: {
                title: "Contribuyendo con caminos transitables para el elk",
                excerpt:
                    "Activa la preferencia de transitabilidad para el elk, revisa las nuevas estimaciones de tiempo y certifica los atajos peatonales que tu elk puede cruzar para que el planificador confíe en ellos a velocidad completa.",
                tags: ["guía", "multijugador", "planificador de rutas", "elk"],
                Component: ContributingElkWalkableRoadsPost,
            },
            fr: {
                title: "Contribuer avec des routes praticables pour l'élan",
                excerpt:

                    "Activez la préférence de transitabilité pour l'élan, consultez les nouvelles estimations de temps et certifiez les raccourcis piétons que votre élan peut traverser pour que le planificateur leur fasse confiance à pleine vitesse.",
                tags: ["guide", "multijoueur", "planificateur de routes", "élan"],
                Component: ContributingElkWalkableRoadsPost,
            },
            nl: {
                title: "Bijdragen met eland-doorwaadbare wegen",
                excerpt:
                    "Schakel de voorkeur voor eland-doorwaadbaarheid in, bekijk de nieuwe tijdschattingen en keur de voetgangersafkortingen goed die jouw eland kan oversteken, zodat de planner ze op volle snelheid vertrouwt.",
                tags: ["gids", "multiplayer", "routeplanner", "eland"],
                Component: ContributingElkWalkableRoadsPost,
            }
        },
    },
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
            es: {
                title: "Agregar y renombrar puntos de referencia",
                excerpt:
                    "Agrega puntos de referencia con nombre al mapa compartido de TOPS, renombra los tuyos en vivo y sugiere nuevos nombres para las etiquetas de cualquier persona, incluida la revisión de las solicitudes pendientes por parte de los administradores.",
                tags: ["guía", "multijugador", "mapa-tops", "puntos-de-referencia"],
                Component: ManagingLandmarksPost,
            },
            fr: {
                title: "Ajouter et renommer des points de repère",
                excerpt:
                    "Ajoutez des points de repère nommés à la carte partagée de TOPS, renommez les vôtres en direct et suggérez de nouveaux noms pour les étiquettes de n'importe qui, y compris la révision des demandes en attente par les administrateurs.",
                tags: ["guide", "multijoueur", "carte-tops", "points-de-repère"],
                Component: ManagingLandmarksPost,
            },
            nl: {
                title: "Landmarks toevoegen en hernoemen",
                excerpt:
                    "Voeg benoemde landmarks toe aan de gedeelde TOPS-kaart, hernoem je eigen landmarks live en stel nieuwe namen voor de labels van anderen voor, inclusief hoe pending verzoeken worden beoordeeld door admins.",
                tags: ["gids", "multiplayer", "tops-kaart", "landmarks"],
                Component: ManagingLandmarksPost,
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
            es: {
                title: "Agregar translocators usando capturas de pantalla",
                excerpt:
                    "Cómo tomar capturas de pantalla claras de los puntos finales, subir un par de TL para revisión, entender el estado del análisis y leer las advertencias antes de la aprobación del administrador.",
                tags: ["guía", "multijugador", "translocators", "capturas-de-pantalla"],
                Component: SubmittingTranslocatorScreenshotsPost,
            },
            fr: {
                title: "Ajouter des translocators à l'aide de captures d'écran",
                excerpt:
                    "Comment prendre des captures d'écran claires des points de terminaison, télécharger une paire de TL pour examen, comprendre l'état de l'analyse et lire les avertissements avant l'approbation de l'administrateur.",
                tags: ["guide", "multijoueur", "translocators", "captures-d'écran"],
                Component: SubmittingTranslocatorScreenshotsPost,
            },
            nl: {
                title: "Translocators toevoegen met screenshots",
                excerpt:
                    "Hoe maak je duidelijke screenshots van de eindpunten, upload je een TL-paar voor beoordeling, begrijp je de analytestatus en lees je waarschuwingen voordat een admin goedkeurt.",
                tags: ["gids", "multiplayer", "translocators", "screenshots"],
                Component: SubmittingTranslocatorScreenshotsPost,
            }
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
            es: {
                title: "Agregar translocadores usando puntos de referencia",
                excerpt:
                    "Una guía paso a paso para exportar tus puntos de referencia en espiral, subir client-chat.log, revisar emparejamientos y enviar TLs al mapa compartido de TOPS.",
                tags: ["guía", "multijugador", "translocators", "puntos de referencia"],
                Component: AddingTranslocatorsWithContributeTLsPost,
            },
            fr: {
                title: "Ajouter des translocators à l'aide de points de référence",
                excerpt:
                    "Un guide étape par étape pour exporter vos points de référence en spirale, télécharger client-chat.log, revoir les appariements et soumettre des TLs à la carte partagée de TOPS.",
                tags: ["guide", "multijoueur", "translocators", "points de référence"],
                Component: AddingTranslocatorsWithContributeTLsPost,
            },
            nl: {
                title: "Translocators toevoegen met waypoints",
                excerpt:
                    "Een stapsgewijze gids voor het exporteren van je spiraal-waypoints, het uploaden van client-chat.log, het beoordelen van paringen en het indienen van TL's op de gedeelde TOPS-kaart.",
                tags: ["gids", "multiplayer", "translocators", "waypoints"],
                Component: AddingTranslocatorsWithContributeTLsPost,
            }
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
            es: {
                title: "Contribuyendo al Mapa en Línea de TOPS",
                excerpt:
                    "Una guía amigable sobre cómo los archivos de caché del mapa subidos por los jugadores se convierten en mosaicos en el mapa compartido de TOPS y cómo hacer una contribución limpia que sea aprobada.",
                tags: ["guía", "multijugador", "tops-map"],
                Component: ContributingToTopsMapPost,
            },
            fr: {
                title: "Contribuer à la carte en ligne de TOPS",
                excerpt:
                    "Un guide convivial sur la façon dont les fichiers de cache de carte téléchargés par les joueurs deviennent des tuiles sur la carte partagée de TOPS et comment faire une contribution propre qui soit approuvée.",
                tags: ["guide", "multijoueur", "tops-map"],
                Component: ContributingToTopsMapPost,
            },
            nl: {
                title: "Bijdragen aan de TOPS Online Kaart",
                excerpt:
                    "Een vriendelijke uitleg over hoe door spelers geüploade kaartcachebestanden veranderen in tegels op de gedeelde TOPS-kaart - en hoe je een schone bijdrage levert die wordt goedgekeurd.",
                tags: ["gids", "multiplayer", "tops-kaart"],
                Component: ContributingToTopsMapPost,
            }
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
