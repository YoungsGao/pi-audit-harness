package audit.demo;

class SearchService {
    UserRepository repository;

    String search(String input) {
        return repository.query(input);
    }
}
