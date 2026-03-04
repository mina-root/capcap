const token = "secret_something";
const version = "2022-06-28";

async function test() {
    console.log("Testing Notion File Uploads API...");
    try {
        const res = await fetch("https://api.notion.com/v1/file_uploads", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Notion-Version": version,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({})
        });
        console.log("Status:", res.status);
        const body = await res.text();
        console.log("Body:", body);
    } catch (err) {
        console.error(err);
    }
}

test();
