import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ACCOUNTS = ["NorbertoC", "norbsurvesy"];
const YEARS_TO_RENDER = 3;
const OUTPUT_DIR = "assets";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const currentYear = new Date().getUTCFullYear();
const years = Array.from({ length: YEARS_TO_RENDER }, (_, index) => currentYear - index);

const contributionQuery = `
query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from, to:$to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            contributionCount
            date
            weekday
          }
        }
      }
    }
  }
}`;

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getFirstSunday(year) {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  return addDays(yearStart, -yearStart.getUTCDay());
}

function getWeeksForYear(year) {
  const yearEnd = new Date(Date.UTC(year, 11, 31));
  const firstSunday = getFirstSunday(year);
  const weeks = [];

  for (let weekStart = firstSunday; weekStart <= yearEnd; weekStart = addDays(weekStart, 7)) {
    const days = [];

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(weekStart, weekday);
      days.push({
        date: isoDate(date),
        inYear: date.getUTCFullYear() === year,
        weekday,
      });
    }

    weeks.push(days);
  }

  return weeks;
}

function monthLabels(year) {
  const firstSunday = getFirstSunday(year);
  const seenMonths = new Set();
  const labels = [];

  for (let weekIndex = 0; weekIndex < 54; weekIndex += 1) {
    const weekStart = addDays(firstSunday, weekIndex * 7);

    for (let weekday = 0; weekday < 7; weekday += 1) {
      const date = addDays(weekStart, weekday);
      const month = date.getUTCMonth();

      if (date.getUTCFullYear() === year && date.getUTCDate() === 1 && !seenMonths.has(month)) {
        labels.push({
          label: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
          x: 32 + weekIndex * 12,
        });
        seenMonths.add(month);
      }
    }
  }

  return labels;
}

function scoreColor(count) {
  if (count === 0) return "#ebedf0";
  if (count <= 3) return "#9be9a8";
  if (count <= 7) return "#40c463";
  if (count <= 12) return "#30a14e";
  return "#216e39";
}

async function fetchContributions(login, year) {
  const { stdout } = await execFileAsync("gh", [
    "api",
    "graphql",
    "-f",
    `query=${contributionQuery}`,
    "-f",
    `login=${login}`,
    "-f",
    `from=${year}-01-01T00:00:00Z`,
    "-f",
    `to=${year}-12-31T23:59:59Z`,
  ]);
  const parsed = JSON.parse(stdout);
  return parsed.data.user.contributionsCollection;
}

function flattenCalendar(collection) {
  const days = new Map();

  for (const week of collection.contributionCalendar.weeks) {
    for (const day of week.contributionDays) {
      days.set(day.date, day.contributionCount);
    }
  }

  return days;
}

function combineYear(year, collections) {
  const daysByAccount = collections.map(flattenCalendar);
  const weeks = getWeeksForYear(year);
  const days = [];

  for (const week of weeks) {
    for (const day of week) {
      const count = day.inYear
        ? daysByAccount.reduce((total, accountDays) => total + (accountDays.get(day.date) || 0), 0)
        : 0;

      days.push({ ...day, count });
    }
  }

  const total = collections.reduce(
    (sum, collection) => sum + collection.contributionCalendar.totalContributions,
    0,
  );

  return { days, total, year };
}

function buildYearSvg(summary) {
  const cell = 10;
  const gap = 2;
  const left = 32;
  const top = 22;
  const width = 676;
  const height = 116;
  const firstSunday = getFirstSunday(summary.year);

  const rects = summary.days
    .map((day) => {
      const date = new Date(`${day.date}T00:00:00Z`);
      const weekIndex = Math.floor((date - firstSunday) / (7 * 24 * 60 * 60 * 1000));
      const x = left + weekIndex * (cell + gap);
      const y = top + day.weekday * (cell + gap);
      const fill = day.inYear ? scoreColor(day.count) : "#ffffff";
      const opacity = day.inYear ? "1" : "0";

      return `<rect fill="${fill}" opacity="${opacity}" data-date="${day.date}" data-count="${day.count}" x="${x}" y="${y}" width="${cell}" height="${cell}"><title>${escapeXml(day.date)}: ${day.count} contributions</title></rect>`;
    })
    .join("\n  ");

  const weekdays = [
    { label: "Mon", y: 40 },
    { label: "Wed", y: 64 },
    { label: "Fri", y: 88 },
  ]
    .map(
      ({ label, y }) =>
        `<text x="0" y="${y}" style="fill:#57606a;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;font-size:9px;">${label}</text>`,
    )
    .join("\n  ");

  const months = monthLabels(summary.year)
    .map(
      ({ label, x }) =>
        `<text x="${x}" y="10" style="fill:#57606a;font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;font-size:10px;">${label}</text>`,
    )
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${summary.year} GitHub activity graph</title>
  <desc id="desc">${summary.total} contributions across GitHub accounts in ${summary.year}.</desc>
  <style>rect { shape-rendering: crispEdges; } text { white-space: nowrap; }</style>
  ${rects}
  ${weekdays}
  ${months}
</svg>
`;
}

await mkdir(resolve(repoRoot, OUTPUT_DIR), { recursive: true });

for (const year of years) {
  const collections = await Promise.all(ACCOUNTS.map((account) => fetchContributions(account, year)));
  const summary = combineYear(year, collections);
  await writeFile(
    resolve(repoRoot, OUTPUT_DIR, `github-activity-${year}.svg`),
    buildYearSvg(summary),
    "utf8",
  );
}
