16 mechs drop onto the OSU Oval, with buildings, rooftops, and trees to fight around, as a zone closes in over about seven minutes. Every mech starts with an arm gun; a mortar, a charged laser and lightning are picked up during the match, and power cubes from kills and crates buy upgrades. Placement counts, not kills: dying first with five kills scores worse than surviving to the end with none.

Play in your browser right now at https://play.joinbuilders.org. Scored matches are bot-only: ten times a second your code receives what your mech sees and hears, and replies with where to move, aim, and fire.

Start in three steps
1. Download mechfight-kit.tar.gz below and copy its Python or TypeScript folder to the root of a public GitHub repo (Dockerfile at the top).

2. Build your image and test it with check/check.py using the command in the kit's README.

3. Push (at most 20 MB at the submitted commit) and submit the repo URL here.

Any language, libraries, or AI are allowed. Builds run on linux/amd64 with network access in at most 10 minutes; pin versions because finalists are rebuilt.

Bot interface and limits
Speak mechfight/1 JSON lines on stdin and stdout (protocol.md).

You have 50 ms to answer each observation. Late answers are skipped, and your mech holds its last move and aim without firing for 1 second before standing still. Answer times vary by a few ms between runs and machines, so a bot that answers near the limit can score differently on a rerun.
Your container gets 1 CPU, 512 MB of memory, and the read-only map at /arena.
At runtime there is no network access, no root (your bot runs as uid 65534, so install packages system-wide), and no disk writes outside /tmp (64 MB).
Docs and starter files
protocol.md
Download
Full rulebook: arena, weapons, observations, actions, and mechfight/1 protocol (also in mechfight-kit.tar.gz).
mechfight-kit.tar.gz
Python and TypeScript starter bots, wrappers, Dockerfiles, protocol.md, JSON Schema, check/check.py, and map.
Scoring
Metric
Placement points, higher is better
Baseline to beat
1.15 (Starter: the kit's Python example bot)
Formula
mean of (16 - place) over every match in a run
Ties
Equal scores rank the earlier submission first.
Scorer version
builders-3
Each match gives 16 - place points: 15 for a win, 0 for dying first. Same-tick deaths share a place. Your score is the mean across all matches.

Rules
Practice plays 48 matches against 15 house bots (4 easy, 4 medium, 4 hard, 3 expert) acting as one squad: they share vision, never fight each other, and hunt you weakest first (one early, more as you thin them out, all of them late).
Practice seeds are private and fixed all event. Your bot never sees the seed, and your slot and spawn vary each match.
Every entry must build and pass check/check.py under the runtime limits. Failed builds or checks are rejected with the reason and never affect your best score.
A bot that crashes or stops answering stays in any match as a sitting target and is scored, not rejected.
Your team may submit 4 times an hour, and a submission usually takes a few minutes to score. The leaderboard ranks each team's best practice score alongside the starter bot.
Keep your repository public with every submitted commit until results are published; an entry that cannot be fetched or built for the final scores nothing.
The final
At the cutoff, your chosen submission (your best unless you pick another) locks with its practice score. The top 32 teams enter a qualifying round: each plays 16 matches (16-mech free-for-alls) against other qualifiers on new seeds. The top 16 by qualifying mean (16 - place) advance and are announced without scores. All 16 finalists play a 64-match series (16-mech free-for-alls) together on new seeds; the last 4 play live at the venue and count the same. The series mean alone decides finalist rankings, and earlier submissions break all ties. Organizers may adjust match counts before the final starts, never after. With fewer than 32 teams, everyone plays qualifying; with 16 or fewer, everyone plays the series. Expert house bots fill empty slots. If a qualifying entry fails to fetch or build, it sits out and the next practice-board team takes its seat. Non-finalists rank below finalists (eliminated qualifiers by qualifying score, then others in practice-board order, shown as negative scores). Standings stay hidden until the last match ends.

The cutoff is Sun 10:00 AM CST.