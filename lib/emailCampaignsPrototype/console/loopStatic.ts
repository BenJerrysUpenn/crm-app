// The loop's fixed words: the send-time slots and the published sources
// behind them and behind the research-list approaches. Copy, not data: the
// numbers here are quoted from the sources, never from our sends.

import type { EvidenceFact, SlotFact } from "./loop";

export const E = {
  ours: (finding: string): EvidenceFact => ({ source: "Our own sends since August (sales numbers)", url: null, finding }),
  gongLabs: { source: "Gong Labs, 304,174 B2B emails", url: "https://www.gong.io/resources/labs/this-surprising-cold-email-cta-will-help-you-book-a-lot-more-meetings/", finding: "On cold emails, asking whether they are interested beat asking for a set time. Once a deal was active, a set time did better." },
  gongBlog: { source: "Gong blog, 300,000+ B2B emails", url: "https://www.gong.io/blog/these-are-the-best-sales-email-tips-youll-read-in-2021", finding: "Cold email success was 30% with an interest ask, 15% with a set time, 13% with an open meeting ask." },
  replyIo: { source: "Reply.io research (no date or sample given)", url: "https://reply.io/wp-content/uploads/How-to-write-better-cold-emails-Reply-Research.pdf", finding: "Against: emails with no question got 11% more replies; three questions cut replies by up to 21%. So: one question, never three." },
  elder: { source: "Elder & Krishna 2010, Journal of Consumer Research", url: "https://scholarsarchive.byu.edu/facpub/8440", finding: "Copy that used several senses raised how good food was expected to taste. The effect weakened when readers were busy." },
  sahni: { source: "Sahni, Wheeler & Chintagunta 2018 (Chicago Booth Review)", url: "https://www.chicagobooth.edu/review/open-name-why-personalized-email-subject-lines-work", finding: "Personalised subject lines raised leads about 30% and cut unsubscribes about 17%." },
  aguirre: { source: "Aguirre et al. 2015, Journal of Retailing", url: "https://ideas.repec.org/a/eee/jouret/v91y2015i1p34-49.html", finding: "Personalising helps when people know where the data came from; their own booking with us is that." },
  liebman: { source: "Liebman & Mahoney 2017, American Economic Review (NBER w19481)", url: "https://www.nber.org/papers/w19481", finding: "Federal spending in the last week of the fiscal year runs 4.9 times the weekly average. Government, not offices; many schools end their year in June." },
  challenger: { source: "Challenger, Gray & Christmas holiday party survey 2024", url: "https://www.challengergray.com/blog/2024-rate-of-parties-on-par-with-2023-but-with-lower-budgets-companies-optimistic-on-hiring-business-conditions-heading-into-new-year/", finding: "64% of companies planned an in-person holiday party (75% before 2020); in 2023, 58% held it during work hours." },
  smartlead: { source: "Smartlead, 850M emails, Jan to Jun 2026 (vendor data)", url: "https://www.smartlead.ai/benchmarks/best-time-of-day-to-send-cold-email", finding: "Reply rate by the reader's local hour falls through the day: 10am 1.19%, 11am 1.05%, 1pm 0.86%, 3pm 0.83%. No bounce after lunch." },
  belkins: { source: "Belkins, 7.5M cold emails, 2025 (vendor data)", url: "https://belkins.io/blog/best-time-to-send-email", finding: "Morning sends 0.54% replies, afternoon 0.47%." },
  ezcater: { source: "ezCater survey of 5,000 employees (a catering seller)", url: "https://ezcater.com/lunchrush/?p=40521", finding: "62% have a treat in the mid-afternoon slump, 37% mid-morning." },
  monk: { source: "Monk 2005, the post-lunch dip (review)", url: "https://www.em-consulte.com/article/415175/the-post-lunch-dip-in-performance", finding: "Alertness dips mid-afternoon, with or without lunch." },
  read: { source: "Read & van Leeuwen 1998, appetite and future choices", url: "https://pubmed.ncbi.nlm.nih.gov/9831521/", finding: "People choosing food for a week later chose more treats when they chose hungry in the late afternoon." },
} satisfies Record<string, EvidenceFact | ((s: string) => EvidenceFact)>;

export const SLOTS: SlotFact[] = [
  { id: "late_morning", label: "Late morning", at: "10:30", why: "Where nearly every email has gone so far (the sender ran at 10am), and where vendor data says replies peak.", evidence: [E.smartlead, E.belkins] },
  { id: "before_lunch", label: "Before lunch", at: "11:40", why: "Hungry, and about to think about food.", evidence: [E.read] },
  { id: "slump", label: "3pm slump", at: "15:00", why: "When most people reach for a treat. Vendor data says replies are lower then; this checks it for food.", evidence: [E.ezcater, E.monk, E.smartlead] },
];
