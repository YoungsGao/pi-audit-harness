package audit.demo;

class Web {
    SearchService service;

    @GetMapping("/users/search")
    String search(String keyword) {
        return service.search(keyword);
    }

    @GetMapping("/users/export")
    String export(String filter) {
        return service.search(filter);
    }
}
