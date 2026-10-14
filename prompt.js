export const EXTRACTION_PROMPT = `You are an expert basketball table official. The image is a photo of a handwritten paper basketball scoresheet (FIBA, FCBQ, Basketball Ireland or similar). Transcribe it faithfully into the JSON schema. Do NOT compute statistics: only read what is written.

How to read the RUNNING SCORE section:
- Each team has its own running-score column(s) with the cumulative score (1, 2, 3, ...), either preprinted or handwritten. Next to the cumulative score the scorer writes the jersey number of the player who scored.
- A field goal is usually marked by a slash or diagonal through the new score; a free throw is usually a single cumulative point (+1) with the jersey written and no slash (some sheets mark FTs with a filled dot or a parenthesis spanning several rows).
- A three-pointer has the jersey number CIRCLED (threePointer = true).
- The end of each period is marked by a thick circle around the score and/or a line under it; ink often changes colour between periods (red for Q1/Q3, blue or black for Q2/Q4).
- Only cumulative scores that were actually reached are marked. Skip unmarked numbers.

For every team, list EVERY scoring entry in the running score in increasing order of cumulative total: { total, jersey, threePointer, freeThrow }. Do this for BOTH teams, including the away column. "total" is the team's cumulative score after that basket. The first marked row is often 2, not a later number: if row 2 (or any earlier row) has a jersey written, it must be in the list. Read jersey digits carefully; they must normally be one of the jersey numbers on that team's roster. If a digit is ambiguous, pick the roster number that best matches the handwriting and mention the doubt in "notes". If a jersey is illegible, use "?".

Consecutive totals usually differ by 1, 2 or 3. A jump of 4 or more almost always means you skipped a marked row: re-check before answering.

Also read, for BOTH teams and with the same care for the away team as for the home team:
- Team names (A = home/left, B = away/right), coaches, date, time, venue, competition.
- Roster: every row of the player list (Name of Players and Kit No.), for both teams. Read the handwritten name and the kit number exactly as written; do not invent, translate or complete a name. Kit numbers stay with the same player all season. Also read personal fouls: count one foul per occupied foul box (a "P2" written in one box is a single foul, not two). Players with no marks get 0. "played" is true if the player-in / entered boxes are marked (X, tick or slash) or the player scored or fouled; false if those boxes are empty.
- Do not leave the away team's players, fouls or running score empty when they are written on the sheet.
- quarterEndTotals: each team's cumulative score at the end of Q1, Q2, Q3 and Q4 (from the circled end-of-period scores). Add overtime ends if present.
- quarterScores: points scored IN each period if the sheet has a summary box with them (e.g. "Scores Period 1 A 36 B 13"). Leave empty if not written.
- finalScore of each team.

Return only JSON that follows the schema.`;

export function buildResponseSchema(Schema) {
  const scoringEntry = Schema.object({
    properties: {
      total: Schema.integer({ description: 'Cumulative team score after this entry' }),
      jersey: Schema.string({ description: 'Jersey number written next to the score, or "?"' }),
      threePointer: Schema.boolean({ description: 'Jersey number is circled' }),
      freeThrow: Schema.boolean({ description: 'Entry is a free throw' }),
    },
    optionalProperties: ['threePointer', 'freeThrow'],
  });
  const player = Schema.object({
    properties: {
      number: Schema.string(),
      name: Schema.string(),
      fouls: Schema.integer(),
      played: Schema.boolean({ description: 'Player-in boxes are marked' }),
    },
    optionalProperties: ['name', 'fouls', 'played'],
  });
  const team = Schema.object({
    properties: {
      side: Schema.enumString({ enum: ['A', 'B'] }),
      name: Schema.string(),
      coach: Schema.string(),
      players: Schema.array({ items: player }),
      scoring: Schema.array({ items: scoringEntry }),
      quarterEndTotals: Schema.array({ items: Schema.integer() }),
      quarterScores: Schema.array({ items: Schema.integer() }),
      finalScore: Schema.integer(),
    },
    optionalProperties: ['coach', 'quarterEndTotals', 'quarterScores', 'finalScore'],
  });
  return Schema.object({
    properties: {
      sheetType: Schema.string(),
      game: Schema.object({
        properties: {
          competition: Schema.string(),
          date: Schema.string(),
          time: Schema.string(),
          venue: Schema.string(),
        },
        optionalProperties: ['competition', 'date', 'time', 'venue'],
      }),
      teams: Schema.array({ items: team }),
      notes: Schema.array({ items: Schema.string() }),
    },
    optionalProperties: ['sheetType', 'notes'],
  });
}
