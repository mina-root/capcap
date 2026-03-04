use reqwest::Client;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let notion_api_token = "secret"; // Placeholder
    let notion_version = "2022-06-28";

    // Test STEP 1
    println!("Testing Step 1...");
    let upload_res = client.post("https://api.notion.com/v1/file_uploads")
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", notion_api_token))
        .header("Notion-Version", notion_version)
        .json(&serde_json::json!({}))
        .send()
        .await?;

    println!("Step 1 Status: {}", upload_res.status());
    let body = upload_res.text().await?;
    println!("Step 1 Body: {}", body);

    Ok(())
}
