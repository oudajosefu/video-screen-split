use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../controller-ui/dist/"]
struct ControllerAssets;

pub async fn index() -> Response {
    serve("index.html")
}

pub async fn asset(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.is_empty() {
        return serve("index.html");
    }
    if ControllerAssets::get(path).is_some() {
        serve(path)
    } else {
        // SPA fallback: any unknown path returns index.html so client routing works.
        serve("index.html")
    }
}

pub async fn asset_at(Path(path): Path<String>) -> Response {
    let full = format!("assets/{path}");
    if ControllerAssets::get(&full).is_some() {
        serve(&full)
    } else {
        serve("index.html")
    }
}

fn serve(path: &str) -> Response {
    match ControllerAssets::get(path) {
        Some(file) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime.as_ref())
                .body(Body::from(file.data.into_owned()))
                .unwrap()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
