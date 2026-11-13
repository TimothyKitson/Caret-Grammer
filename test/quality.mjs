// A scoreboard, not a pass/fail suite.
//
//   node test/quality.mjs
//
// Two numbers matter. FALSE ALARMS: correct writing that got underlined - the
// thing that makes a checker unusable. MISSES: real mistakes it walked past.
// Run it before and after any change to the engine or the word lists.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDictionary } from '../src/engine/dictionary.js';
import { check } from '../src/engine/engine.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (name) => fs.readFileSync(path.join(ROOT, 'data', name), 'utf8');
const dict = createDictionary({
  wordsText: read('words.txt'),
  frequencyText: read('frequency.txt'),
  properNounsText: read('propernouns.txt'),
  misspellings: JSON.parse(read('misspellings.json')),
});

const issuesIn = (text) => check(text, { dict }, {}).issues;

// --------------------------------------------------------------- the corpus

// Ordinary, correct writing. Nothing in here should be underlined.
const CLEAN = `
That is good. This is good. I am good. It's good to see you.
This is will, the new intern. I am rich in the ways that count.
Thanks, hope you had a nice weekend. Give my regards to the family.
It's may already and the garden is late. The rose by the gate is open.
I met will at the station. Tell grace I said hello. Please ask bill about it.
I want to mark the date on the calendar. He will may his way through it.
The bill came to forty dollars. A frank conversation is overdue.
Her grace under pressure was remarkable. We rose early and walked to town.
I hope you are well. From the beginning this was a bad idea. I love this.
Let me know if you need anything else. I am happy to help.
Please find the attached report and let me know what you think.
The meeting has been moved to Thursday at two in the afternoon.
We received your application and will be in touch within the week.
I apologize for the delay in getting back to you about the schedule.
Our records show the payment was processed on the fifteenth.
The committee reviewed the proposal and recommended a few changes.
Students should bring a pencil, a notebook, and their reading log.
Dismissal is at three o'clock, except on early release days.
Please sign the permission slip and return it by Friday morning.
The office will be closed Monday in observance of the holiday.
Lunch is served between eleven thirty and twelve forty-five.
If your child is absent, call the front office before nine.
Report cards go home on the last Friday of each quarter.
We are grateful for the support of our families this year.
The spring concert is scheduled for the second week of May.
Parent-teacher conferences will be held over two evenings.
Please update your contact information in the parent portal.
Students in grades six through eight may join the robotics club.
The library is open after school on Tuesdays and Thursdays.
Uniforms must be clean, pressed, and worn as described in the handbook.
I would like to schedule a time to discuss my daughter's progress.
Thank you for your patience while we sort out the bus routes.
A reminder that the deadline for registration is next Wednesday.
We have had a wonderful first month and the children are settling in.
The playground equipment was inspected and repaired over the break.
Field trip forms are due by the end of the day on Friday.
Breakfast is available in the cafeteria starting at seven fifteen.
Our teachers have been working hard to prepare for the new term.
The gymnasium will be used for testing on those two mornings.
Please do not park in the fire lane during pickup and dropoff.
I checked the website but could not find the lunch menu for November.
He said he would email me the agenda before the meeting started.
She is going to download the file and print it out this afternoon.
My laptop battery died so I finished the work on my phone.
The wifi in the back building has been slow since the upgrade.
I took a screenshot of the error and sent it to the help desk.
Can you forward me the login details for the new online portal?
The app crashed twice while I was uploading the photos.
We use a spreadsheet to keep track of the fundraiser totals.
The podcast about the solar system was a hit with the fourth graders.
I will text you when I am on my way to pick him up.
There is a typo on the third slide of the presentation.
The printer is offline again and nobody knows the password.
She blogged about the science fair and it got a lot of traffic.
Our newsletter goes out by email on the first of every month.
The video call kept freezing so we switched to a phone call.
I backed up the files to the cloud before reinstalling anything.
He is good at math but he struggles with reading comprehension.
That was a really good idea and I am glad you brought it up.
Good morning, and welcome to the first day of the school year.
It is good practice to proofread anything before you send it.
We had a good turnout at the open house on Thursday evening.
The weather is supposed to be good for the game on Saturday.
Hi Mrs. Patel, just a reminder that picture day is this Thursday.
Could you send me the permission slip by Friday? Thanks so much!
We're out of printer paper again, so I ordered two more boxes.
The bus will be about fifteen minutes late because of the snow.
Please let me know if Jordan needs to be picked up early.
I've attached the agenda for Monday's staff meeting.
Our fundraiser raised $2,340, which is more than last year.
If it rains, recess will be held in the gym.
Each student should bring a water bottle and a packed lunch.
The kids loved the field trip to the science museum.
She said she'd be here by noon, but her flight was delayed.
I can't make it tonight; can we reschedule for next week?
Neither the principal nor the teachers were told about the change.
Everyone in the class has finished their project.
The data shows a clear improvement over last semester.
He doesn't know whether he'll be able to come.
My mom and I are going to the store later.
Who's bringing the snacks for the party on Friday?
Its battery lasts all day, which is great for long trips.
They're planning to visit their grandparents over the break.
There's a meeting at 3:30 in Room 204.
Whose jacket is this? It was left on the playground.
I would have called, but my phone died.
Let's meet at the library after school.
We need to buy milk, eggs, bread, and butter.
The committee has reached its decision.
A number of parents have asked about the new schedule.
The number of students has grown every year.
None of the cookies were left by the end of the day.
I'm not sure if that's the right answer, but it's worth a try.
Lunch will be served at 11:45 sharp.
You're welcome to stop by any time this week.
The teacher gave Sam and me extra homework.
Between you and me, I think the test was too hard.
Our team won the game 3 to 1 on Saturday.
Ms. Lopez will be out sick, so a substitute will cover her class.
Please don't forget to sign and return the report card envelope.
The new playground equipment arrives in April.
Can you believe it's already November?
I really appreciate all the help you gave us this year.
Grades will be posted online by the end of the week.
We should've left earlier to avoid the traffic.
If I were you, I'd talk to the counselor about it.
Go ahead and take a seat; the nurse will be right with you.
The office closes at 4 p.m. on Fridays.
Parent-teacher conferences are scheduled for October 12th and 13th.
Thank you for your patience while we fix the heating system.
My brother's friends are coming over for dinner.
The students' artwork is on display in the hallway.
I'll email you the link once the form is ready.
Can't wait for the weekend!
In 1865, the Civil War ended and the long work of rebuilding began.
The author uses imagery to show how lonely the main character feels.
Photosynthesis is the process plants use to turn sunlight into energy.
In conclusion, both sides of the argument have strong points.
However, not everyone agrees with this view.
For example, many cities have banned plastic bags.
The results suggest that more research is needed.
Although it was raining, the game went on as planned.
After the meeting, we went out for pizza.
I was wondering if you had a chance to look at my essay.
Let me know what you think when you get a chance.
Sorry for the late reply, I've been swamped this week.
Happy birthday! Hope you have an amazing day.
The Johnsons are hosting Thanksgiving this year.
We drove from Denver to Salt Lake City in one day.
I read that book in two days because I couldn't put it down.
Dr. Kim recommends getting at least eight hours of sleep.
The meeting has been moved to Wednesday at 10 a.m.
My favorite subjects are math and art.
Do you want to grab coffee sometime next week?
It's been a while since we last talked.
I'm proud of how much you've grown this year.
The weather was perfect for a hike, so we went to the mountains.
Please RSVP by March 3rd so we can get a head count.
World War I is a big topic in history class.
You and I are on the same team this time.
Our reunion with God is joyful, not shameful.
I applied for three jobs last week.
The flowers in the fields were pretty.
She opened the gates and walked past the banks of the river.
He got good marks on the test.
The fire burns slowly in the hearth.
I need to pat the dog before we go.
She moved with grace and kindness.
Our team was the victor in the final match.
The trail began to peter out near the river.
She held her hair back with a bobby pin.
The sky is grey today.
We have a FREE app that you can use.
He was an FBI agent for ten years.
`.trim().split('\n').map((s) => s.trim()).filter(Boolean);

// Real mistakes. Each should be caught, and the right fix offered.
const MISTAKES = [
  ['She was born in wales.', 'wales', 'Wales'],
  ['We skied in the alps last winter.', 'alps', 'Alps'],
  ['It was a FBI agent.', 'a', 'an'],
  ['I recieved your letter.', 'recieved', 'received'],
  ['It was definately the best one.', 'definately', 'definitely'],
  ['They seperated the piles.', 'seperated', 'separated'],
  ['She is very independant.', 'independant', 'independent'],
  ['That is a seperate issue.', 'seperate', 'separate'],
  ['We need to acommodate everyone.', 'acommodate', 'accommodate'],
  ['The occurence was logged.', 'occurence', 'occurrence'],
  ['He was embarassed by it.', 'embarassed', 'embarrassed'],
  ['It is neccessary to sign.', 'neccessary', 'necessary'],
  ['A publically funded school.', 'publically', 'publicly'],
  ['I beleive you are right.', 'beleive', 'believe'],
  ['Teh cat sat down.', 'Teh', 'The'],
  ['She recomended the book.', 'recomended', 'recommended'],
  ['The goverment said no.', 'goverment', 'government'],
  ['I will definatly be there.', 'definatly', 'definitely'],
  ['It happend yesterday.', 'happend', 'happened'],
  ['Thier car is outside.', 'Thier', 'Their'],
  ['We should of gone earlier.', 'should of', 'should have'],
  ['Alot of people came.', 'Alot', 'A lot'],
  ['He is tallerr than me.', 'tallerr', 'taller'],
  ['The childrens coats are wet.', 'childrens', "children's"],
  ['Its been a long week.', 'Its', "It's"],
  ['Your welcome to join us.', 'Your', "You're"],
  ['They where at the store.', 'where', 'were'],
  ['I could care less about it.', 'could care less', "couldn't care less"],
  ['DOes anyone know?', 'DOes', 'Does'],
  ['The the report is ready.', 'the the', 'the'],
  ['She dont know yet.', 'dont', "doesn't"],
  ['Me and him went together.', 'Me and him', 'He and I'],
  ['Their going to be late.', 'Their', "They're"],
  ['My mom and I is going.', 'is', 'are'],
  ['I is happy.', 'is', 'am'],
  ['My dad and I has a plan.', 'has', 'have'],
  ['Like john would be John.', 'john', 'John'],
  ['We met jason at the park.', 'jason', 'Jason'],
  ['I talked to sam yesterday.', 'sam', 'Sam'],
];

// ------------------------------------------------------------------- scoring

const falseAlarms = [];
let sentences = 0;
for (const sentence of CLEAN) {
  sentences += 1;
  for (const issue of issuesIn(sentence)) {
    falseAlarms.push({
      word: sentence.slice(issue.start, issue.end),
      id: issue.id,
      sentence,
    });
  }
}

const misses = [];
let caught = 0;
for (const [text, wrong, right] of MISTAKES) {
  const issues = issuesIn(text);
  const hit = issues.find((i) => {
    const span = text.slice(i.start, i.end);
    return span.toLowerCase() === wrong.toLowerCase()
      || wrong.toLowerCase().includes(span.toLowerCase())
      || span.toLowerCase().includes(wrong.toLowerCase());
  });
  if (!hit) { misses.push({ text, wrong, why: 'not flagged' }); continue; }
  const fixes = (hit.replacements || hit.fixes || []).map((f) => f.toLowerCase());
  if (right && fixes.length && !fixes.includes(right.toLowerCase())) {
    misses.push({ text, wrong, why: `flagged, but offered ${JSON.stringify(fixes.slice(0, 3))} not "${right}"` });
    continue;
  }
  caught += 1;
}

// -------------------------------------------------------------------- report

const byId = {};
for (const alarm of falseAlarms) byId[alarm.id] = (byId[alarm.id] || 0) + 1;

console.log(`FALSE ALARMS   ${falseAlarms.length} across ${sentences} correct sentences`);
for (const [id, n] of Object.entries(byId).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${id}`);
}
for (const alarm of falseAlarms.slice(0, 25)) {
  console.log(`      "${alarm.word}" in: ${alarm.sentence.slice(0, 72)}`);
}

console.log(`\nMISSES         ${misses.length} of ${MISTAKES.length} real mistakes (caught ${caught})`);
for (const miss of misses) {
  console.log(`      "${miss.wrong}" - ${miss.why}`);
}

console.log(`\nSCORE          ${falseAlarms.length} false alarms, ${misses.length} misses`);
