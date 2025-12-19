
const TRIP_ID_REGEX = /(?:UNW|UN|MW)(\d+)/;
const id = "UP-N_UN377_V1_A";
const match = id.match(TRIP_ID_REGEX);

console.log("ID:", id);
console.log("Match:", match);
if (match) {
    console.log("Extracted:", match[1]);
}
