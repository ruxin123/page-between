// swiftc native/BookSource.swift scripts/verify_book_source.swift -o /tmp/book-source-check
import AppKit
import WebKit

@main struct BookSourceCheck {
  static func main() {
    for address in [
      "https://z-lib.sk/", "https://1lib.sk/book/example",
      "https://books.example.org/search?q=algebra",
    ] {
      precondition(BookSourceWindow.remoteURL(URL(string: address)!))
    }
    for address in [
      "http://books.example.org", "https://localhost/", "https://127.0.0.1/", "https://127.1/",
      "https://0x7f.0.0.1/", "https://[::1]/", "https://device.local/", "https://device.local./",
      "file:///tmp/book.pdf", "data:text/html,book", "javascript:alert(1)",
      "https://user:password@books.example.org/",
    ] {
      precondition(!BookSourceWindow.remoteURL(URL(string: address)!))
    }
    func response(_ path: String, type: String, disposition: String? = nil) -> HTTPURLResponse {
      var headers = ["Content-Type": type]
      if let disposition = disposition { headers["Content-Disposition"] = disposition }
      return HTTPURLResponse(
        url: URL(string: "https://books.example.org/" + path)!, statusCode: 200,
        httpVersion: "HTTP/1.1", headerFields: headers)!
    }
    precondition(
      !BookSourceWindow.isBookResponse(response("index.html", type: "text/html"), canShow: true))
    precondition(
      !BookSourceWindow.isBookResponse(response("login", type: "text/html"), canShow: true))
    precondition(
      BookSourceWindow.isBookResponse(response("book.pdf", type: "application/pdf"), canShow: true))
    precondition(
      BookSourceWindow.isBookResponse(
        response(
          "download", type: "application/epub+zip", disposition: "attachment; filename=sample.epub"),
        canShow: false))
    precondition(
      BookSourceWindow.isBookResponse(
        response("download", type: "text/html", disposition: "attachment; filename=sample.html"),
        canShow: true))
    print(
      "Book source: public HTTPS validation; normal pages stay browsable; book and attachment downloads detected."
    )
  }
}
