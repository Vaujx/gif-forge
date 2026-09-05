import webview

from api import Api, resource_path


def main():
    api = Api()
    window = webview.create_window(
        "GIF Forge",
        resource_path("ui", "index.html"),
        js_api=api,
        width=1180,
        height=760,
        min_size=(920, 600),
        background_color="#0E0E0C",
        text_select=False,
    )
    webview.start(debug=False)


if __name__ == "__main__":
    main()
